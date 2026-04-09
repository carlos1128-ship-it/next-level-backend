import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, Cookie } from 'puppeteer';
import { PrismaService } from '../../prisma/prisma.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as path from 'path';
import * as fs from 'fs';

puppeteer.use(StealthPlugin());

export interface ShopeeOrder {
  orderId: string;
  status: string;
  totalAmount: number;
  customerName: string;
  occurredAt?: string;
}

@Injectable()
export class ShopeeScraperService {
  private readonly logger = new Logger(ShopeeScraperService.name);
  private activeLoginSessions = new Map<string, { browser: Browser; page: Page }>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 🕒 1. Sincronização Automática (Cron Job)
   * Roda a cada 30 minutos para todas as empresas conectadas
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async handleCronSync() {
    this.logger.log('🚀 Iniciando sincronização automática da Shopee...');
    
    // Busca todas as empresas que têm cookies salvos
    const companies = await this.prisma.company.findMany({
      where: {
        shopeeCookies: { not: null }
      },
      select: { id: true, name: true }
    });

    this.logger.log(`Encontradas ${companies.length} empresas para sincronizar.`);

    for (const company of companies) {
      try {
        this.logger.log(`🔄 Sincronizando pedidos da empresa: ${company.name} (${company.id})`);
        const orders = await this.getRecentOrders(company.id);
        
        if (orders.length > 0) {
          await this.syncOrdersToFinancials(company.id, orders);
        }
      } catch (error) {
        this.logger.error(`❌ Erro ao sincronizar empresa ${company.id}: ${error.message}`);
      }
    }
  }

  /**
   * 💰 2. Transformar JSON em Dinheiro
   * Salva os pedidos capturados na tabela FinancialTransaction
   */
  async syncOrdersToFinancials(companyId: string, orders: ShopeeOrder[]) {
    this.logger.log(`[${companyId}] Sincronizando ${orders.length} pedidos para o financeiro...`);

    // Busca o primeiro usuário da empresa para vincular à transação (ou um usuário administrador)
    const companyUser = await this.prisma.user.findFirst({
      where: { companyId }
    });

    if (!companyUser) {
      this.logger.warn(`[${companyId}] Nenhum usuário encontrado para vincular as transações.`);
      return;
    }

    let syncedCount = 0;

    for (const order of orders) {
      // Verifica se a transação já existe pelo order_sn no description
      const existing = await this.prisma.financialTransaction.findFirst({
        where: {
          companyId,
          description: { contains: order.orderId }
        }
      });

      if (!existing) {
        await this.prisma.financialTransaction.create({
          data: {
            companyId,
            userId: companyUser.id,
            type: 'INCOME',
            amount: order.totalAmount,
            description: `Shopee Order: ${order.orderId} - Cliente: ${order.customerName}`,
            category: 'Vendas Shopee',
            occurredAt: new Date(), // Pode ser a data do pedido se capturada no XHR
          }
        });
        syncedCount++;
      }
    }

    this.logger.log(`[${companyId}] Sincronização concluída. ${syncedCount} novas transações criadas.`);
  }

  /**
   * Part 1: Start login process and check if OTP is required
   */
  async initializeLogin(companyId: string, credentials?: { user?: string; pass?: string }) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { shopeeUser: true, shopeePass: true }
    });

    const user = credentials?.user || company?.shopeeUser || process.env.SHOPEE_USER;
    const pass = credentials?.pass || company?.shopeePass || process.env.SHOPEE_PASS;

    if (!user || !pass) {
      throw new BadRequestException("Credenciais da Shopee não fornecidas.");
    }

    // Save them to DB for future use if provided
    if (credentials?.user || credentials?.pass) {
      await this.prisma.company.update({
        where: { id: companyId },
        data: {
          shopeeUser: user,
          shopeePass: pass
        }
      });
    }

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }) as any;

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    try {
      this.logger.log(`[${companyId}] Navigating to Shopee Signin...`);
      await page.goto('https://seller.shopee.com.br/account/signin', { waitUntil: 'networkidle2' });

      await page.waitForSelector('input[name="identifier"]');
      await page.type('input[name="identifier"]', user, { delay: 50 });
      await page.type('input[name="password"]', pass, { delay: 50 });
      
      await page.click('button[type="submit"]');

      // Wait to see if it asks for OTP or navigates to dashboard
      await new Promise(r => setTimeout(r, 6000));

      const isOtpPage = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return !!document.querySelector('input[placeholder*="código"]') || 
               !!document.querySelector('.shopee-input-code') ||
               text.includes('verificação') ||
               text.includes('vaildar') ||
               text.includes('otp');
      });

      if (isOtpPage) {
        this.logger.warn(`[${companyId}] OTP required. Saving session to Map.`);
        await this.saveScreenshot(page, `shopee-otp-${companyId}`);
        this.activeLoginSessions.set(companyId, { browser, page });
        return { 
          status: 'OTP_REQUIRED', 
          message: 'Código de verificação solicitado pela Shopee.',
          debugScreenshot: `shopee-otp-${companyId}.png`
        };
      }

      // If already redirected to a dash URL
      if (page.url().includes('portal/sale/order') || page.url().includes('portal/dashboard') || page.url().includes('portal/settings')) {
        this.logger.log(`[${companyId}] Login successful without OTP.`);
        await this.saveSession(page, companyId);
        await browser.close();
        return { status: 'SUCCESS', message: 'Conectado com sucesso' };
      }

      this.logger.error(`[${companyId}] Unknown login state. Current URL: ${page.url()}`);
      await this.saveScreenshot(page, `shopee-login-error-${companyId}`);
      await browser.close();
      throw new Error('Falha ao identificar estado de login ou CAPTCHA detectado');
    } catch (error) {
      this.logger.error(`[${companyId}] initializeLogin Error: ${error.message}`);
      if (browser) await browser.close();
      throw error;
    }
  }

  /**
   * Part 2: Submit the OTP code provided by the user
   */
  async submitVerificationCode(companyId: string, code: string) {
    const session = this.activeLoginSessions.get(companyId);
    if (!session) {
      throw new BadRequestException('Sessão de login expirada ou não encontrada. Reinicie o processo.');
    }

    const { page, browser } = session;

    try {
      this.logger.log(`[${companyId}] Submitting OTP code...`);
      
      // Attempt to input the code
      await page.keyboard.type(code, { delay: 100 });
      await page.keyboard.press('Enter');

      // Wait for navigation
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);

      if (page.url().includes('portal/dashboard') || page.url().includes('portal/sale/order')) {
        this.logger.log(`[${companyId}] OTP successful! Saving cookies.`);
        await this.saveSession(page, companyId);
        this.activeLoginSessions.delete(companyId);
        await browser.close();
        return { status: 'SUCCESS', message: 'Shopee conectada com sucesso!' };
      }

      // Check for error messages
      const errorMsg = await page.evaluate(() => {
        const err = document.querySelector('.shopee-form-item__error-message');
        return err ? err.textContent : 'Código inválido ou expirado';
      });

      this.logger.error(`[${companyId}] Verification failed: ${errorMsg}`);
      await this.saveScreenshot(page, `shopee-otp-fail-${companyId}`);
      throw new Error(errorMsg || 'Erro na verificação do código');
    } catch (error) {
      this.logger.error(`[${companyId}] submitVerificationCode Error: ${error.message}`);
      this.activeLoginSessions.delete(companyId);
      await browser.close();
      throw error;
    }
  }

  /**
   * Scrape recent orders using existing database cookies
   */
  async getRecentOrders(companyId: string): Promise<ShopeeOrder[]> {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }) as any;
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    try {
      this.logger.log(`[${companyId}] Loading cookies from database...`);
      const hasCookies = await this.loadSession(page, companyId);
      
      if (!hasCookies) {
        throw new BadRequestException('Nenhum cookie salvo. Faça login na Shopee primeiro.');
      }

      this.logger.log(`[${companyId}] Navigating to orders page...`);
      await page.goto('https://seller.shopee.com.br/portal/sale/order', { waitUntil: 'networkidle2' });

      // If redirected to signin, cookies are invalid
      if (page.url().includes('account/signin') || page.url().includes('signin')) {
        this.logger.warn(`[${companyId}] Cookies expired or invalid. Redirection detected.`);
        throw new BadRequestException('Sessão Shopee expirada. Refaça o login no Hub.');
      }

      this.logger.log(`[${companyId}] Intercepting api/v3/order/get_order_list...`);
      
      let capturedOrders: ShopeeOrder[] = [];

      const xhrPromise = new Promise<void>((resolve) => {
        page.on('response', async (response) => {
          if (response.url().includes('api/v3/order/get_order_list')) {
            try {
              const data = await response.json();
              if (data?.data?.order_list) {
                capturedOrders = data.data.order_list.map((o: any) => ({
                  orderId: o.order_sn,
                  status: o.status_msg,
                  totalAmount: o.total_amount,
                  customerName: o.buyer_user?.user_name || 'N/A'
                }));
                resolve();
              }
            } catch (e) {}
          }
        });
      });

      // Wait max 15 seconds for the XHR to fire
      await Promise.race([xhrPromise, new Promise(r => setTimeout(r, 15000))]);

      if (capturedOrders.length === 0) {
        this.logger.warn(`[${companyId}] XHR interception timed out or found no data.`);
      }

      return capturedOrders;
    } finally {
      await browser.close();
    }
  }

  private async saveSession(page: Page, companyId: string) {
    const cookies = await page.cookies();
    await this.prisma.company.update({
      where: { id: companyId },
      data: { shopeeCookies: JSON.stringify(cookies) }
    });
    this.logger.log(`[${companyId}] Cookies updated in database.`);
  }

  private async loadSession(page: Page, companyId: string): Promise<boolean> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { shopeeCookies: true }
    });

    if (company?.shopeeCookies) {
      try {
        const cookies = JSON.parse(company.shopeeCookies) as Cookie[];
        await page.setCookie(...cookies);
        return true;
      } catch (e) {
        this.logger.error(`Error parsing cookies: ${e.message}`);
        return false;
      }
    }
    return false;
  }

  /**
   * 🧹 3. Limpeza de Rastro (Render)
   * Apaga o print antigo sempre que gerar um novo
   */
  private async saveScreenshot(page: Page, name: string) {
    try {
      const filePath = path.join(process.cwd(), `${name}.png`);
      
      // Se já existir um print antigo com esse nome, deleta
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      await page.screenshot({ path: filePath });
      this.logger.log(`Screenshot salva (e antiga limpa): ${filePath}`);
    } catch (e) {
      this.logger.error(`Falha ao capturar screenshot: ${e.message}`);
    }
  }
}
