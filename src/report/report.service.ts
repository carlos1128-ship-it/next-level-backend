import { Injectable, Logger } from '@nestjs/common';
import * as puppeteer from 'puppeteer';

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  async generateMarginReportPdf(
    companyName: string,
    productName: string,
    sellingPrice: number,
    costPrice: number,
    taxes: number,
    shipping: number,
    profit: number,
    margin: number,
  ): Promise<Buffer> {
    const htmlContent = `
      <html>
        <head>
          <style>
            body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1f2937; padding: 40px; }
            h1 { color: #10b981; font-size: 28px; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px; }
            .content { margin-top: 30px; }
            .item { font-size: 16px; margin: 10px 0; }
            .val { font-weight: bold; }
            .highlight { background-color: #ecfdf5; padding: 15px; border-radius: 8px; margin-top: 20px; }
            .profit-val { font-size: 24px; color: ${profit >= 0 ? '#10b981' : '#ef4444'}; font-weight: 800; }
            .warning { color: #ef4444; font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>Relatório de Margem Real - ${companyName}</h1>
          <div class="content">
            <div class="item">Produto Analisado: <span class="val">${productName}</span></div>
            <div class="item">Preço de Venda Praticado: <span class="val">R$ ${Number(sellingPrice).toFixed(2)}</span></div>
            <div class="item">Custo ABSOLUTO Mapeado: <span class="val">R$ ${Number(costPrice).toFixed(2)}</span></div>
            <div class="item">Impostos/Taxas Embutidas: <span class="val">R$ ${Number(taxes).toFixed(2)}</span></div>
            <div class="item">Frete Logística Estimada: <span class="val">R$ ${Number(shipping).toFixed(2)}</span></div>
            
            <div class="highlight">
              <h3>Diagnóstico Final da Operação</h3>
              <p>O lucro líquido projetado por unidade é de <span class="profit-val">R$ ${Number(profit).toFixed(2)}</span>.</p>
              <p>Sua operação possui atualmente uma margem de segurança e lucro de <span class="val">${Number(margin).toFixed(2)}%</span>.</p>
              <br/>
              <p><strong>Recomendação AI:</strong> ${
                profit > 0 
                ? 'A margem atual viabiliza investimento no funil de performance em campanhas de retenção Ads mantendo o break-even financeiro sustentável.' 
                : '<span class="warning">Operação com déficit crítico (ou zerado). A precificação não cobre imposto, frete ou custo de mercadoria (CMV). Exige reprecificação emergencial imediata ou redução do Custo Fornecedor. A escala com essas margens custará a sobrevivência da empresa!</span>'
              }</p>
            </div>
          </div>
        </body>
      </html>
    `;

    try {
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();
      await page.setContent(htmlContent, { waitUntil: 'load' });
      // Force return type any since page.pdf type differs sometimes
      const pdfBuffer: any = await page.pdf({ format: 'A4', printBackground: true });
      await browser.close();

      return Buffer.from(pdfBuffer);
    } catch (error) {
      this.logger.error('Error generating PDF', error);
      throw new Error('Could not generate PDF');
    }
  }
}
