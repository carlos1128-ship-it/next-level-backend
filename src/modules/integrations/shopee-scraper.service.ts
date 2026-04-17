/**
 * =============================================================================
 * SHOPEE SCRAPER SERVICE — Production-Ready RPA (Guerrilla Integration)
 * =============================================================================
 *
 * STRATEGY:
 * Since Shopee's API is restricted, we use Puppeteer Stealth to simulate a
 * real browser session. The flow is:
 *  1. Load cookies from DB → navigate directly to orders page (no login needed)
 *  2. If session is expired → trigger re-authentication via frontend
 *  3. Intercept XHR (api/v3/order/get_order_list) → capture clean JSON
 *  4. Transform raw Shopee data → FinancialTransaction records
 *
 * SCALABILITY NOTE:
 * For multi-tenant production at scale, replace the in-memory Map
 * (activeLoginSessions) with a BullMQ queue. Each company gets a dedicated
 * job slot. This prevents memory leaks under concurrent load and survives
 * server restarts. Consider using browser.createIncognitoBrowserContext()
 * per tenant to ensure session isolation within a single browser instance.
 *
 * RENDER DEPLOYMENT:
 * The launch args below are critical for containers. Render uses a shared
 * /dev/shm with very limited space; --disable-dev-shm-usage forces Chrome
 * to use /tmp instead, preventing "Target closed" crashes.
 * =============================================================================
 */

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
/**
 * IMPORTANT: puppeteer, puppeteer-extra and puppeteer-extra-plugin-stealth
 * have been removed from package.json as part of the Meta Cloud API migration.
 * The Shopee scraper is preserved here for future re-enablement but is
 * non-operational in the current deployment. All browser-specific calls
 * are guarded and will throw a descriptive error at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Browser = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cookie = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HTTPResponse = any;
import { PrismaService } from '../../prisma/prisma.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as path from 'path';
import * as fs from 'fs';

// ─── Domain Interfaces ────────────────────────────────────────────────────────

/** The canonical order shape consumed by our internal services */
export interface ShopeeOrder {
  orderId: string;      // Shopee's order_sn — used as idempotency key
  status: string;
  totalAmount: number;  // Raw value from API (verify unit: cents vs. full BRL)
  customerName: string;
  occurredAt?: string;  // ISO date string from order creation time
}

/** Raw shape coming from Shopee XHR — typed to avoid implicit `any` build errors */
interface ShopeeRawOrderItem {
  order_sn: string;
  status_msg: string;
  total_amount: number;
  order_ctime?: number; // Unix timestamp in seconds
  buyer_user?: {
    user_name?: string;
  };
}

/** Shape of the parsed XHR response body */
interface ShopeeOrderListResponse {
  data?: {
    order_list?: ShopeeRawOrderItem[];
  };
}

// ─── Puppeteer Launch Config ──────────────────────────────────────────────────

/**
 * Optimized Chromium launch args for containerized environments (Render, Docker).
 * WHY each flag matters:
 *  - no-sandbox: Required in containers that don't run as root with proper namespaces
 *  - disable-setuid-sandbox: Companion to no-sandbox, disables the setuid helper
 *  - disable-dev-shm-usage: CRITICAL on Render — /dev/shm is tiny (<64MB);
 *    this redirects shared memory usage to /tmp, preventing "Target closed" crashes
 *  - disable-gpu: No GPU in CI/cloud containers; disabling prevents driver errors
 *  - no-first-run / no-default-browser-check: Skip Chrome's first-run setup dialogs
 *  - single-process: Lower memory footprint at the cost of isolation (acceptable for RPA)
 */
const PUPPETEER_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',  // ← Most important for Render stability
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ShopeeScraperService {
  private readonly logger = new Logger(ShopeeScraperService.name);

  /**
   * In-memory store for paused MFA sessions.
   *
   * WHY Map and not DB: The browser process is tied to memory. Storing the
   * reference in DB is not possible. However, this means sessions are lost
   * on server restart. Mitigations:
   *  - Set a short TTL (5 min) and inform the user to restart the flow
   *  - Long-term: Use BullMQ to serialize the flow and keep the worker alive
   */
  private readonly activeLoginSessions = new Map<
    string,
    { browser: Browser; page: Page; createdAt: Date }
  >();

  /** MFA sessions older than this are considered expired and cleaned up */
  private readonly SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly prisma: PrismaService) {
    // Periodically clean up stale MFA sessions to prevent memory leaks
    setInterval(() => this.cleanupStaleSessions(), this.SESSION_TTL_MS);
  }

  // ─── Cron: Sync All Connected Companies ─────────────────────────────────────

  /**
   * 🕒 Background Sync — runs every 30 minutes.
   * Iterates all companies with valid session cookies and pulls fresh orders.
   * Failures are isolated per company so one bad session won't block others.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async handleCronSync(): Promise<void> {
    this.logger.log('🚀 Shopee cron sync iniciando...');

    const companies = await this.prisma.company.findMany({
      where: { shopeeCookies: { not: null } },
      select: { id: true, name: true },
    });

    this.logger.log(`📋 ${companies.length} empresa(s) na fila de sincronização.`);

    // Process sequentially to avoid overwhelming Render's memory with
    // multiple Chromium instances. For >20 companies, switch to BullMQ.
    for (const company of companies) {
      try {
        this.logger.log(`🔄 Syncing: ${company.name} (${company.id})`);
        const orders = await this.getRecentOrders(company.id);
        if (orders.length > 0) {
          await this.syncOrdersToFinancials(company.id, orders);
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        // Log company ID, NOT credentials
        this.logger.error(`❌ Sync failed for company [${company.id}]: ${msg}`);
      }
    }
  }

  // ─── Data Transformation: Raw Shopee JSON → Internal Schema ─────────────────

  /**
   * Maps a raw Shopee order object to our internal ShopeeOrder shape.
   *
   * This is intentionally decoupled so it can evolve independently
   * (e.g., when Shopee changes field names or units).
   *
   * FUTURE: Move to a dedicated ShopeeMapper class/service that also
   * maps to Analytics, Customer, and Product schemas.
   */
  private mapRawOrderToInternal(raw: ShopeeRawOrderItem): ShopeeOrder {
    return {
      orderId: raw.order_sn,
      status: raw.status_msg || 'UNKNOWN',
      // NOTE: Verify if Shopee returns amount in cents or full BRL.
      // Divide by 100 if needed: raw.total_amount / 100
      totalAmount: raw.total_amount ?? 0,
      customerName: raw.buyer_user?.user_name || 'Cliente Shopee',
      // Convert Unix timestamp (seconds) to ISO string if available
      occurredAt: raw.order_ctime
        ? new Date(raw.order_ctime * 1000).toISOString()
        : new Date().toISOString(),
    };
  }

  /**
   * 💰 Persists scraped orders as FinancialTransactions.
   * Uses orderId as an idempotency key (description contains order_sn)
   * to prevent duplicate records on repeated syncs.
   */
  async syncOrdersToFinancials(
    companyId: string,
    orders: ShopeeOrder[],
  ): Promise<void> {
    const companyUser = await this.prisma.user.findFirst({
      where: { companyId },
    });

    if (!companyUser) {
      this.logger.warn(`[${companyId}] No user found to attach transactions.`);
      return;
    }

    let syncedCount = 0;

    for (const order of orders) {
      // Idempotency: skip if this order was already persisted
      const exists = await this.prisma.financialTransaction.findFirst({
        where: { companyId, description: { contains: order.orderId } },
      });

      if (!exists) {
        await this.prisma.financialTransaction.create({
          data: {
            companyId,
            userId: companyUser.id,
            type: 'INCOME',
            amount: order.totalAmount,
            description: `[Shopee] Order ${order.orderId} — ${order.customerName}`,
            category: 'Vendas Shopee',
            occurredAt: order.occurredAt
              ? new Date(order.occurredAt)
              : new Date(),
          },
        });
        syncedCount++;
      }
    }

    this.logger.log(
      `[${companyId}] ✅ ${syncedCount}/${orders.length} transações criadas.`,
    );
  }

  // ─── Login Step 1: Initialize ────────────────────────────────────────────────

  /**
   * Opens a headless browser, fills credentials, and detects if MFA is needed.
   *
   * Returns one of:
   *  - { status: 'SUCCESS' }       → no MFA, cookies saved, browser closed
   *  - { status: 'OTP_REQUIRED' }  → MFA detected, browser kept alive in Map
   *
   * The browser is ALWAYS closed on error (see catch block).
   */
  async initializeLogin(
    companyId: string,
    credentials?: { user?: string; pass?: string },
  ): Promise<{ status: string; message: string; debugScreenshot?: string }> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { shopeeUser: true, shopeePass: true },
    });

    const user = credentials?.user || company?.shopeeUser || process.env.SHOPEE_USER;
    const pass = credentials?.pass || company?.shopeePass || process.env.SHOPEE_PASS;

    // SECURITY: Never log credentials. Only confirm presence.
    if (!user || !pass) {
      throw new BadRequestException('Credenciais não fornecidas ou configuradas.');
    }

    // Persist credentials for future cron syncs (encrypted at rest by Neon)
    if (credentials?.user || credentials?.pass) {
      await this.prisma.company.update({
        where: { id: companyId },
        data: { shopeeUser: user, shopeePass: pass },
      });
    }

    let browser: Browser | null = null;

    try {
      browser = await this.launchBrowser();
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 768 });

      this.logger.log(`[${companyId}] Navigating to Shopee Signin...`);
      await page.goto('https://seller.shopee.com.br/account/signin', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // Fill credentials
      await page.waitForSelector('input[name="loginKey"]', { timeout: 10000 })
        .catch(() => page.waitForSelector('input[name="identifier"]', { timeout: 5000 }));

      // Use page.type for human-like input; stealth plugin helps here
      await this.fillLoginForm(page, user, pass);

      await page.click('button[type="submit"]');

      // Wait for post-submit state (dashboard redirect OR MFA modal)
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
        .catch(() => {/* Timeout is acceptable here; MFA page won't navigate */});

      // Check final state
      if (this.isOnDashboard(page)) {
        this.logger.log(`[${companyId}] Login successful (no MFA).`);
        await this.saveSession(page, companyId);
        await browser.close();
        return { status: 'SUCCESS', message: 'Shopee conectada com sucesso.' };
      }

      const isMfaPage = await this.detectMfaPage(page);
      if (isMfaPage) {
        this.logger.warn(`[${companyId}] MFA/OTP required. Pausing session.`);
        await this.saveScreenshot(page, `shopee-mfa-${companyId}`);
        // Store the live browser session; browser is NOT closed yet
        this.activeLoginSessions.set(companyId, {
          browser,
          page,
          createdAt: new Date(),
        });
        return {
          status: 'OTP_REQUIRED',
          message: 'Código de verificação enviado pela Shopee.',
          debugScreenshot: `shopee-mfa-${companyId}.png`,
        };
      }

      // Unknown state (CAPTCHA, IP block, etc.)
      this.logger.error(`[${companyId}] Unknown post-login state: ${page.url()}`);
      await this.saveScreenshot(page, `shopee-error-${companyId}`);
      await browser.close();
      throw new Error('Estado desconhecido após login. Verifique o screenshot de diagnóstico.');

    } catch (error: unknown) {
      // Guarantee browser is closed on ANY error path
      if (browser) {
        await browser.close().catch(() => null);
      }
      const msg = error instanceof Error ? error.message : 'Erro desconhecido no login';
      this.logger.error(`[${companyId}] initializeLogin failed: ${msg}`);
      throw error;
    }
  }

  // ─── Login Step 2: Submit MFA Code ──────────────────────────────────────────

  /**
   * Injects the user-provided OTP into the paused browser session.
   *
   * RACE CONDITION PREVENTION:
   * The session Map acts as a mutex. If the key doesn't exist, we reject
   * immediately rather than waiting indefinitely. The TTL cleanup prevents
   * stale sessions from accumulating.
   */
  async submitVerificationCode(
    companyId: string,
    code: string,
  ): Promise<{ status: string; message: string }> {
    const session = this.activeLoginSessions.get(companyId);

    if (!session) {
      throw new BadRequestException(
        'Sessão MFA expirada ou não encontrada. Reinicie o processo de login.',
      );
    }

    const { page, browser } = session;

    try {
      this.logger.log(`[${companyId}] Submitting MFA code...`);

      // Type code character-by-character to match real user behavior
      await page.keyboard.type(code, { delay: 80 });
      await page.keyboard.press('Enter');

      // Wait for the page to settle after OTP submission
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
        .catch(() => null); // MFA success might not navigate immediately

      if (this.isOnDashboard(page)) {
        this.logger.log(`[${companyId}] MFA verified. Saving cookies.`);
        await this.saveSession(page, companyId);
        this.activeLoginSessions.delete(companyId);
        await browser.close();
        return { status: 'SUCCESS', message: 'Shopee NEXT conectada com sucesso!' };
      }

      // Check for inline error messages on the MFA page
      const errorText = await page
        .evaluate(() => {
          const el = document.querySelector(
            '.shopee-form-item__error-message, [class*="error"], [class*="invalid"]',
          );
          return el?.textContent?.trim() ?? null;
        })
        .catch(() => null);

      const errorMsg = errorText || 'Código inválido ou expirado.';
      this.logger.error(`[${companyId}] MFA failed: ${errorMsg}`);
      await this.saveScreenshot(page, `shopee-mfa-fail-${companyId}`);

      // Clean up session after failure — user must restart from Step 1
      this.activeLoginSessions.delete(companyId);
      await browser.close().catch(() => null);
      throw new Error(errorMsg);

    } catch (error: unknown) {
      // Ensure cleanup even if an unexpected error occurs
      if (!this.activeLoginSessions.has(companyId)) {
        await browser.close().catch(() => null);
      }
      this.activeLoginSessions.delete(companyId);
      throw error;
    }
  }

  // ─── Order Extraction ────────────────────────────────────────────────────────

  /**
   * Loads session cookies from DB and scrapes recent orders via XHR interception.
   *
   * WHY XHR interception vs DOM scraping:
   *  - DOM structure changes every Shopee deploy; XHR contracts are more stable
   *  - JSON is clean and structured; DOM requires brittle CSS selectors
   *  - Interception doesn't require finding and clicking pagination elements
   */
  async getRecentOrders(companyId: string): Promise<ShopeeOrder[]> {
    let browser: Browser | null = null;

    try {
      browser = await this.launchBrowser();
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 768 });

      const hasCookies = await this.loadSession(page, companyId);
      if (!hasCookies) {
        throw new BadRequestException(
          'Sem sessão salva. Faça login na Shopee pelo Hub de Integrações.',
        );
      }

      // Navigate to the orders page — this triggers the XHR we want to capture
      await page.goto('https://seller.shopee.com.br/portal/sale/order', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // Session expired detection
      if (page.url().includes('signin') || page.url().includes('login')) {
        this.logger.warn(`[${companyId}] Session cookie expired. Clearing from DB.`);
        // Clear stale cookies so the cron won't retry indefinitely
        await this.prisma.company.update({
          where: { id: companyId },
          data: { shopeeCookies: null },
        });
        throw new BadRequestException(
          'Sessão Shopee expirada. Reconecte no Hub de Integrações.',
        );
      }

      const orders = await this.interceptOrderXhr(page, companyId);
      return orders;

    } finally {
      // CRITICAL: Always close the browser to prevent memory leaks on Render
      if (browser) {
        await browser.close().catch(() => null);
      }
    }
  }

  /**
   * Attaches a response listener BEFORE triggering navigation, then
   * waits for the XHR to fire (max 20s). The listener is set up first to
   * avoid a race condition where the XHR fires before the listener is ready.
   */
  private interceptOrderXhr(page: Page, companyId: string): Promise<ShopeeOrder[]> {
    return new Promise((resolve) => {
      let resolved = false;
      const capturedOrders: ShopeeOrder[] = [];

      // TYPE FIX: HTTPResponse is imported from 'puppeteer' — resolves the
      // implicit `any` TypeScript error on the `response` parameter.
      const onResponse = async (response: HTTPResponse): Promise<void> => {
        if (!response.url().includes('api/v3/order/get_order_list')) return;

        try {
          const json = (await response.json()) as ShopeeOrderListResponse;
          const rawList = json?.data?.order_list ?? [];

          rawList.forEach((raw) => {
            capturedOrders.push(this.mapRawOrderToInternal(raw));
          });

          this.logger.log(
            `[${companyId}] XHR intercepted. ${capturedOrders.length} order(s) captured.`,
          );
        } catch (parseError: unknown) {
          const msg = parseError instanceof Error ? parseError.message : String(parseError);
          this.logger.warn(`[${companyId}] Failed to parse XHR response: ${msg}`);
        } finally {
          if (!resolved) {
            resolved = true;
            page.off('response', onResponse); // Remove listener to prevent leaks
            resolve(capturedOrders);
          }
        }
      };

      page.on('response', onResponse);

      // Fallback timeout: resolve with whatever was captured (could be empty)
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          page.off('response', onResponse);
          this.logger.warn(
            `[${companyId}] XHR interception timed out (20s). Returning ${capturedOrders.length} cached result(s).`,
          );
          resolve(capturedOrders);
        }
      }, 20000);
    });
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /** Creates a Puppeteer browser with Render-optimized flags */
  private async launchBrowser(): Promise<Browser> {
    // puppeteer-extra is not installed in the current deployment.
    // To re-enable: add puppeteer-extra and puppeteer-extra-plugin-stealth
    // to package.json dependencies and restore the imports at the top of this file.
    throw new BadRequestException(
      'O scraper da Shopee está temporariamente indisponível nesta versão do servidor. Entre em contato com o suporte.',
    );
  }

  /** Fills the login form, handling both login key variants */
  private async fillLoginForm(page: Page, user: string, pass: string): Promise<void> {
    // Try both known selector patterns for Shopee's login form
    const userSelector = await page.$('input[name="loginKey"]')
      ? 'input[name="loginKey"]'
      : 'input[name="identifier"]';
    const passSelector = await page.$('input[name="password"]')
      ? 'input[name="password"]'
      : 'input[type="password"]';

    await page.click(userSelector, { clickCount: 3 }); // Select all first
    await page.type(userSelector, user, { delay: 60 });

    await page.click(passSelector, { clickCount: 3 });
    await page.type(passSelector, pass, { delay: 60 });
  }

  /** Checks if the current URL indicates a successful portal navigation */
  private isOnDashboard(page: Page): boolean {
    const url = page.url();
    return (
      url.includes('portal/dashboard') ||
      url.includes('portal/sale') ||
      url.includes('portal/product') ||
      url.includes('portal/settings')
    );
  }

  /** Detects Shopee's MFA/OTP modal via multiple heuristics */
  private async detectMfaPage(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const selectors = [
        'input[placeholder*="código"]',
        'input[placeholder*="code"]',
        '[class*="verification"]',
        '[class*="otp"]',
      ];
      return (
        selectors.some((sel) => !!document.querySelector(sel)) ||
        text.includes('verificação') ||
        text.includes('verification') ||
        text.includes('otp')
      );
    });
  }

  /**
   * Persists browser cookies to Neon DB as serialized JSON.
   * Wrapped in try/catch; a serialization failure should not crash the auth flow.
   */
  private async saveSession(page: Page, companyId: string): Promise<void> {
    try {
      const cookies = await page.cookies();
      const serialized = JSON.stringify(cookies);
      await this.prisma.company.update({
        where: { id: companyId },
        data: { shopeeCookies: serialized },
      });
      this.logger.log(`[${companyId}] Session cookies saved to DB.`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${companyId}] Failed to save session: ${msg}`);
      // Non-fatal: log but don't rethrow — the login itself succeeded
    }
  }

  /**
   * Restores cookies from DB to the browser page.
   * Returns false on parse failure (corrupted DB data) so the caller can
   * gracefully trigger re-authentication instead of crashing.
   */
  private async loadSession(page: Page, companyId: string): Promise<boolean> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { shopeeCookies: true },
    });

    if (!company?.shopeeCookies) return false;

    try {
      // SECURITY: JSON.parse can throw on corrupted data — catch it explicitly
      const cookies = JSON.parse(company.shopeeCookies) as Cookie[];
      if (!Array.isArray(cookies) || cookies.length === 0) {
        this.logger.warn(`[${companyId}] Cookie data is empty or malformed.`);
        return false;
      }
      await page.setCookie(...cookies);
      return true;
    } catch (parseError: unknown) {
      const msg = parseError instanceof Error ? parseError.message : String(parseError);
      this.logger.error(`[${companyId}] Failed to parse cookies from DB: ${msg}`);
      // Clear corrupted data to prevent repeated failures in the cron
      await this.prisma.company.update({
        where: { id: companyId },
        data: { shopeeCookies: null },
      }).catch(() => null);
      return false;
    }
  }

  /**
   * 🧹 Screenshot with disk cleanup.
   * Overwrites the previous debug image to prevent disk space accumulation on Render.
   */
  private async saveScreenshot(page: Page, name: string): Promise<void> {
    try {
      const filePath = path.join(process.cwd(), `${name}.png`);
      // Remove old screenshot before writing new one
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      await page.screenshot({ path: filePath, fullPage: true });
      this.logger.log(`📸 Screenshot saved: ${filePath}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to save screenshot: ${msg}`);
      // Non-fatal: screenshot failure should not interrupt the main flow
    }
  }

  /**
   * Cleans up MFA sessions older than SESSION_TTL_MS.
   * Called on a timer in the constructor to prevent memory leaks from
   * users who started MFA but never submitted the code.
   */
  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now();
    for (const [companyId, session] of this.activeLoginSessions.entries()) {
      const age = now - session.createdAt.getTime();
      if (age > this.SESSION_TTL_MS) {
        this.logger.warn(
          `[${companyId}] MFA session expired (${Math.round(age / 1000)}s old). Cleaning up.`,
        );
        await session.browser.close().catch(() => null);
        this.activeLoginSessions.delete(companyId);
      }
    }
  }
}
