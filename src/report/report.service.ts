import { Injectable, Logger } from '@nestjs/common';

/**
 * ReportService — PDF Generation
 *
 * Puppeteer was removed from this project (Meta Cloud API migration).
 * PDF is now generated as an HTML string returned to the frontend,
 * which triggers a browser-native print/save-as-PDF.
 *
 * Required env vars: none
 * Required packages: none (no puppeteer dependency)
 */
@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  /**
   * Returns an HTML report as a Buffer (UTF-8 encoded).
   * The frontend receives this as a Blob and opens it in a new tab,
   * where the user can use Ctrl+P / cmd+P to save as PDF.
   */
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
    const profitColor = profit >= 0 ? '#10b981' : '#ef4444';
    const recommendation =
      profit > 0
        ? 'A margem atual viabiliza investimento em campanhas de performance e retenção, mantendo o break-even financeiro sustentável.'
        : '<span style="color:#ef4444;font-weight:bold;">Operação com déficit crítico. A precificação não cobre impostos, frete ou custo de mercadoria (CMV). Exige reprecificação imediata ou redução do custo de fornecedor.</span>';

    const htmlContent = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Relatório de Margem — ${companyName}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif; color: #111827; background: #fff; padding: 48px; }
    h1 { color: #10b981; font-size: 26px; font-weight: 800; border-bottom: 2px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 24px; }
    .label { font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
    .value { font-size: 16px; font-weight: 600; color: #111827; }
    .row { display: flex; justify-content: space-between; align-items: flex-start; padding: 14px 0; border-bottom: 1px solid #f3f4f6; }
    .highlight { background: #ecfdf5; border-radius: 12px; padding: 24px; margin-top: 28px; }
    .profit-val { font-size: 28px; font-weight: 800; color: ${profitColor}; }
    .meta { margin-top: 40px; font-size: 11px; color: #9ca3af; }
  </style>
</head>
<body>
  <h1>Relatório de Margem Real</h1>
  <p style="font-size:14px;color:#6b7280;margin-bottom:28px;">Empresa: <strong style="color:#111827;">${companyName}</strong></p>

  <div class="row"><div><div class="label">Produto Analisado</div><div class="value">${productName}</div></div></div>
  <div class="row"><div><div class="label">Preço de Venda Praticado</div><div class="value">R$ ${Number(sellingPrice).toFixed(2)}</div></div></div>
  <div class="row"><div><div class="label">Custo Absoluto Mapeado</div><div class="value">R$ ${Number(costPrice).toFixed(2)}</div></div></div>
  <div class="row"><div><div class="label">Impostos/Taxas</div><div class="value">R$ ${Number(taxes).toFixed(2)}</div></div></div>
  <div class="row"><div><div class="label">Frete/Logística Estimada</div><div class="value">R$ ${Number(shipping).toFixed(2)}</div></div></div>
  <div class="row"><div><div class="label">Margem de Segurança</div><div class="value">${Number(margin).toFixed(2)}%</div></div></div>

  <div class="highlight">
    <div class="label" style="margin-bottom:8px;">Diagnóstico Final da Operação</div>
    <div class="profit-val">R$ ${Number(profit).toFixed(2)} / unidade</div>
    <p style="margin-top:14px;font-size:14px;line-height:1.7;">${recommendation}</p>
  </div>

  <div class="meta">Gerado por Next Level AI · ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}</div>
</body>
</html>`;

    this.logger.log(`PDF HTML report generated for company: ${companyName}`);
    return Buffer.from(htmlContent, 'utf-8');
  }
}
