import { Injectable, Logger } from '@nestjs/common';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, Cookie } from 'puppeteer';
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
  private readonly sessionPath = path.join(process.cwd(), '.shopee_session.json');
  private browser: Browser | null = null;

  async getRecentOrders(): Promise<ShopeeOrder[]> {
    const page = await this.initPage();
    
    try {
      this.logger.log('Navigating to Shopee Seller Center Orders page...');
      // URL for Brazilian Seller Center Orders
      await page.goto('https://seller.shopee.com.br/portal/sale/order', { waitUntil: 'networkidle2' });

      // Check if we need to login
      if (page.url().includes('account/signin')) {
        this.logger.warn('Session expired or not found. Attempting login...');
        await this.login(page);
        // After login, navigate back to orders if not redirected
        if (!page.url().includes('portal/sale/order')) {
          await page.goto('https://seller.shopee.com.br/portal/sale/order', { waitUntil: 'networkidle2' });
        }
      }

      this.logger.log('Extracting orders...');
      
      let capturedOrders: ShopeeOrder[] = [];

      // Intercept XHR response for orders
      const orderXhrPromise = new Promise<void>((resolve) => {
        page.on('response', async (response) => {
          const url = response.url();
          if (url.includes('api/v2/order/get_order_list') || url.includes('api/v2/orders')) {
            try {
              const data = await response.json();
              if (data?.data?.order_list) {
                capturedOrders = data.data.order_list.map((order: any) => ({
                  orderId: order.order_sn,
                  status: order.status_msg,
                  totalAmount: order.total_amount,
                  customerName: order.buyer_user?.user_name || 'N/A'
                }));
                this.logger.log(`Intercepted ${capturedOrders.length} orders from XHR`);
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
        new Promise(resolve => setTimeout(resolve, 5000)) // Wait max 5 seconds for XHR
      ]);

      if (capturedOrders.length > 0) {
        return capturedOrders;
      }

      // Fallback to DOM extraction
      this.logger.warn('XHR interception failed or timed out. Falling back to DOM scraping...');
      await page.waitForSelector('.order-list-item', { timeout: 10000 }).catch(() => {
        this.logger.error('Order list selector not found.');
      });

      // Simple DOM extraction as a baseline
      const orders = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.order-list-item'));
        return items.map(item => {
          const orderId = item.querySelector('.order-sn')?.textContent?.trim() || 'N/A';
          const status = item.querySelector('.order-status')?.textContent?.trim() || 'N/A';
          const totalAmountStr = item.querySelector('.order-total-price')?.textContent?.trim() || '0';
          const customerName = item.querySelector('.buyer-name')?.textContent?.trim() || 'N/A';
          
          // Basic number cleanup for BRL
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
      this.logger.error(`Failed to get recent orders: ${error.message}`);
      await this.saveScreenshot(page, 'orders_error');
      throw error;
    } finally {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
    }
  }

  private async login(page: Page) {
    const user = process.env.SHOPEE_USER;
    const pass = process.env.SHOPEE_PASS;

    if (!user || !pass) {
      throw new Error('SHOPEE_USER or SHOPEE_PASS not found in environment variables');
    }

    try {
      this.logger.log('Filling login form...');
      await page.waitForSelector('input[name="identifier"]');
      await page.type('input[name="identifier"]', user, { delay: 100 });
      await page.type('input[name="password"]', pass, { delay: 100 });
      
      await page.click('button[type="submit"]');

      // Wait for navigation or CAPTCHA
      const response = await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null);

      // Check for CAPTCHA or error
      const isCaptcha = await page.evaluate(() => {
        return !!document.querySelector('.shopee-captcha') || !!document.querySelector('#nc_1_wrapper');
      });

      if (isCaptcha) {
        this.logger.error('CAPTCHA detected during login! Please handle manually or check screenshot.');
        await this.saveScreenshot(page, 'captcha_login');
        throw new Error('CAPTCHA detected');
      }

      if (page.url().includes('account/signin')) {
        this.logger.error('Login failed, still on sign-in page.');
        await this.saveScreenshot(page, 'login_failed');
        throw new Error('Login failed');
      }

      this.logger.log('Login successful! Saving session...');
      await this.saveSession(page);
    } catch (error) {
      this.logger.error(`Login process failed: ${error.message}`);
      throw error;
    }
  }

  private async initPage(): Promise<Page> {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: true, // Set to false for debugging
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }) as any;
    }

    const page = await this.browser!.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    await this.loadSession(page);

    return page;
  }

  private async saveSession(page: Page) {
    const cookies = await page.cookies();
    fs.writeFileSync(this.sessionPath, JSON.stringify(cookies, null, 2));
    this.logger.log(`Session saved to ${this.sessionPath}`);
  }

  private async loadSession(page: Page) {
    if (fs.existsSync(this.sessionPath)) {
      const cookiesString = fs.readFileSync(this.sessionPath, 'utf8');
      const cookies = JSON.parse(cookiesString) as Cookie[];
      await page.setCookie(...cookies);
      this.logger.log('Session loaded from disk');
    }
  }

  private async saveScreenshot(page: Page, name: string) {
    const screenshotDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir);
    }
    const filePath = path.join(screenshotDir, `${name}_${Date.now()}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    this.logger.log(`Screenshot saved to ${filePath}`);
  }
}
