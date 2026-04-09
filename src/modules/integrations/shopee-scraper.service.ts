import { Injectable, Logger } from '@nestjs/common';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, Cookie } from 'puppeteer';
import { PrismaService } from '../../prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';

puppeteer.use(StealthPlugin());

export interface ShopeeOrder {
  orderId: string;
  status: string;
  totalAmount: number;
  customerName: string;
}

@Injectable()
export class ShopeeScraperService {
  private readonly logger = new Logger(ShopeeScraperService.name);
  private browser: Browser | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async getRecentOrders(companyId: string): Promise<ShopeeOrder[]> {
    const page = await this.initPage(companyId);
    
    try {
      this.logger.log(`[${companyId}] Navigating to Shopee Seller Center Orders...`);
      await page.goto('https://seller.shopee.com.br/portal/sale/order', { waitUntil: 'networkidle2' });

      // Check if we need to login
      if (page.url().includes('account/signin') || page.url().includes('signin')) {
        this.logger.warn(`[${companyId}] Session expired or not found. Attempting login...`);
        await this.login(page, companyId);
        
        // After login, navigate back to orders if not redirected
        if (!page.url().includes('portal/sale/order')) {
          await page.goto('https://seller.shopee.com.br/portal/sale/order', { waitUntil: 'networkidle2' });
        }
      }

      this.logger.log(`[${companyId}] Extracting orders via XHR & DOM...`);
      
      let capturedOrders: ShopeeOrder[] = [];

      // Intercept XHR response for orders - api/v3/order/get_order_list
      const orderXhrPromise = new Promise<void>((resolve) => {
        page.on('response', async (response) => {
          const url = response.url();
          // Update to v3 and v2 fallback
          if (url.includes('api/v3/order/get_order_list') || url.includes('api/v2/order/get_order_list')) {
            try {
              const data = await response.json();
              if (data?.data?.order_list) {
                capturedOrders = data.data.order_list.map((order: any) => ({
                  orderId: order.order_sn,
                  status: order.status_msg,
                  totalAmount: order.total_amount,
                  customerName: order.buyer_user?.user_name || 'N/A'
                }));
                this.logger.log(`[${companyId}] Intercepted ${capturedOrders.length} orders from XHR`);
                resolve();
              }
            } catch (e) {
              // Silently fail if not JSON or other issues
            }
          }
        });
      });

      // Wait for a bit to allow XHR to fire, or fallback to DOM
      await Promise.race([
        orderXhrPromise,
        new Promise(resolve => setTimeout(resolve, 8000)) // Wait max 8 seconds for XHR
      ]);

      if (capturedOrders.length > 0) {
        return capturedOrders;
      }

      // Fallback to DOM extraction
      this.logger.warn(`[${companyId}] XHR interception failed or timed out. Falling back to DOM...`);
      await page.waitForSelector('.order-list-item', { timeout: 10000 }).catch(async () => {
        this.logger.error(`[${companyId}] Order list selector not found. Saving debug screenshot.`);
        await this.saveScreenshot(page, 'debug-shopee');
      });

      const orders = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.order-list-item'));
        return items.map(item => {
          const orderId = item.querySelector('.order-sn')?.textContent?.trim() || 'N/A';
          const status = item.querySelector('.order-status')?.textContent?.trim() || 'N/A';
          const totalAmountStr = item.querySelector('.order-total-price')?.textContent?.trim() || '0';
          const customerName = item.querySelector('.buyer-name')?.textContent?.trim() || 'N/A';
          const totalAmount = parseFloat(totalAmountStr.replace(/[^\d,.]/g, '').replace(',', '.'));

          return {
            orderId,
            status,
            totalAmount,
            customerName
          };
        });
      });

      return orders;
    } catch (error) {
      this.logger.error(`[${companyId}] Failed to get recent orders: ${error.message}`);
      await this.saveScreenshot(page, 'debug-shopee');
      throw error;
    } finally {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
    }
  }

  private async login(page: Page, companyId: string) {
    const user = process.env.SHOPEE_USER;
    const pass = process.env.SHOPEE_PASS;

    if (!user || !pass) {
      throw new Error('SHOPEE_USER or SHOPEE_PASS not found in environment variables');
    }

    try {
      this.logger.log(`[${companyId}] Filling login form...`);
      await page.waitForSelector('input[name="identifier"]');
      await page.type('input[name="identifier"]', user, { delay: 50 });
      await page.type('input[name="password"]', pass, { delay: 50 });
      
      await page.click('button[type="submit"]');

      // Wait for navigation or CAPTCHA
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null);

      // Check for CAPTCHA or error
      const isCaptcha = await page.evaluate(() => {
        return !!document.querySelector('.shopee-captcha') || !!document.querySelector('#nc_1_wrapper');
      });

      if (isCaptcha) {
        this.logger.error(`[${companyId}] CAPTCHA detected during login!`);
        await this.saveScreenshot(page, 'debug-shopee');
        throw new Error('CAPTCHA detected');
      }

      if (page.url().includes('account/signin') || page.url().includes('signin')) {
        this.logger.error(`[${companyId}] Login failed, still on sign-in page.`);
        await this.saveScreenshot(page, 'debug-shopee');
        throw new Error('Login failed');
      }

      this.logger.log(`[${companyId}] Login successful! Saving session to database...`);
      await this.saveSession(page, companyId);
    } catch (error) {
      this.logger.error(`[${companyId}] Login process failed: ${error.message}`);
      await this.saveScreenshot(page, 'debug-shopee');
      throw error;
    }
  }

  private async initPage(companyId: string): Promise<Page> {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }) as any;
    }

    const page = await this.browser!.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    await this.loadSession(page, companyId);

    return page;
  }

  private async saveSession(page: Page, companyId: string) {
    const cookies = await page.cookies();
    const cookiesJson = JSON.stringify(cookies);
    
    await this.prisma.company.update({
      where: { id: companyId },
      data: { shopeeCookies: cookiesJson }
    });
    
    this.logger.log(`[${companyId}] Session (cookies) saved to database`);
  }

  private async loadSession(page: Page, companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { shopeeCookies: true }
    });

    if (company?.shopeeCookies) {
      try {
        const cookies = JSON.parse(company.shopeeCookies) as Cookie[];
        await page.setCookie(...cookies);
        this.logger.log(`[${companyId}] Session loaded from database`);
      } catch (e) {
        this.logger.error(`[${companyId}] Failed to parse cookies from database: ${e.message}`);
      }
    }
  }

  private async saveScreenshot(page: Page, name: string) {
    const filePath = path.join(process.cwd(), `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    this.logger.log(`Screenshot saved to ${filePath}`);
  }
}
