import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  FinancialTransactionType,
  IntegrationProvider,
  Prisma,
  SaleChannel,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MercadoLivreApiService } from './mercado-livre-api.service';
import { MercadoLivreAuthService } from './mercado-livre-auth.service';
import { MercadoLivreProductItem, MercadoLivreSyncSummary, JsonRecord } from './mercado-livre.types';
import {
  asDate,
  asInteger,
  asNumber,
  asRecord,
  asRecordArray,
  asString,
  toDecimal,
  toInputJson,
} from './mercado-livre-utils';

@Injectable()
export class MercadoLivreSyncService {
  private readonly logger = new Logger(MercadoLivreSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: MercadoLivreAuthService,
    private readonly api: MercadoLivreApiService,
  ) {}

  async syncAll(companyId: string, userId?: string): Promise<MercadoLivreSyncSummary> {
    this.logger.log(JSON.stringify({ event: 'mercado_livre.sync.started', companyId }));
    const [products, orders, questions, reviews] = await Promise.all([
      this.syncProducts(companyId),
      this.syncOrders(companyId, userId),
      this.syncQuestions(companyId),
      this.syncReviews(companyId),
    ]);

    await this.prisma.mercadoLivreOAuthToken.updateMany({
      where: { companyId },
      data: { lastSyncAt: new Date() },
    });

    await this.refreshAnalytics(companyId);

    this.logger.log(
      JSON.stringify({
        event: 'mercado_livre.sync.completed',
        companyId,
        products,
        orders,
        questions,
        reviews,
      }),
    );

    return {
      products,
      orders,
      questions,
      reviews,
      syncedAt: new Date().toISOString(),
    };
  }

  async syncProducts(companyId: string): Promise<number> {
    const session = await this.authService.getValidAccessToken(companyId);
    const itemIds = await this.api.listSellerItemIds(session.accessToken, session.mlUserId);
    if (!itemIds.length) return 0;

    const items = await this.api.getItems(session.accessToken, itemIds);
    for (const item of items) {
      await this.upsertProduct(companyId, item);
    }
    this.logger.log(
      JSON.stringify({
        event: 'mercado_livre.products.imported',
        companyId,
        count: items.length,
      }),
    );
    return items.length;
  }

  async syncProductById(companyId: string, mlItemId: string): Promise<void> {
    const session = await this.authService.getValidAccessToken(companyId);
    const [item] = await this.api.getItems(session.accessToken, [mlItemId]);
    if (item) await this.upsertProduct(companyId, item);
  }

  async syncOrders(companyId: string, userId?: string, since?: Date): Promise<number> {
    const session = await this.authService.getValidAccessToken(companyId);
    const response = await this.api.getResource<JsonRecord>(
      session.accessToken,
      '/orders/search',
      {
        seller: session.mlUserId,
        sort: 'date_desc',
        limit: 50,
        ...(since ? { 'order.date_created.from': since.toISOString() } : {}),
      },
    );
    const orders = asRecordArray(response.results);
    let saleTransactionsUpserted = 0;
    for (const order of orders) {
      const id = asString(order.id);
      if (id && (await this.syncOrderById(companyId, id, userId))) {
        saleTransactionsUpserted += 1;
      }
    }
    this.logger.log(
      JSON.stringify({
        event: 'mercado_livre.orders.imported',
        companyId,
        count: orders.length,
        saleTransactionsUpserted,
      }),
    );
    return orders.length;
  }

  async syncOrderById(companyId: string, mlOrderId: string, userId?: string): Promise<boolean> {
    const session = await this.authService.getValidAccessToken(companyId);
    const order = await this.api.getResource<JsonRecord>(session.accessToken, `/orders/${mlOrderId}`);
    return this.upsertOrder(companyId, session.mlUserId, order, userId);
  }

  async syncShipmentById(companyId: string, mlShipmentId: string): Promise<void> {
    const session = await this.authService.getValidAccessToken(companyId);
    const shipment = await this.api.getResource<JsonRecord>(session.accessToken, `/shipments/${mlShipmentId}`);
    const mlOrderId =
      asString(shipment.order_id) ||
      asString(asRecord(shipment.order)?.id);

    if (mlOrderId) {
      await this.syncOrderById(companyId, mlOrderId);
    }

    let orderId: string | null = null;
    if (mlOrderId) {
      const order = await this.prisma.mercadoLivreOrder.findUnique({
        where: { mlOrderId },
        select: { id: true },
      });
      orderId = order?.id || null;
    }
    if (!orderId) {
      const existingShipment = await this.prisma.mercadoLivreShipment.findUnique({
        where: { mlShipmentId },
        select: { orderId: true },
      });
      orderId = existingShipment?.orderId || null;
    }
    if (!orderId) {
      this.logger.warn(`Shipment Mercado Livre sem pedido local: ${mlShipmentId}`);
      return;
    }

    await this.upsertShipmentRecord(companyId, orderId, mlShipmentId, shipment);
  }

  async syncQuestions(companyId: string): Promise<number> {
    const session = await this.authService.getValidAccessToken(companyId);
    const response = await this.api.getResource<JsonRecord>(
      session.accessToken,
      '/questions/search',
      { seller_id: session.mlUserId, api_version: 4, limit: 50 },
    );
    const questions = asRecordArray(response.questions);
    for (const question of questions) {
      await this.upsertQuestion(companyId, question);
    }
    return questions.length;
  }

  async syncQuestionById(companyId: string, questionId: string): Promise<void> {
    const session = await this.authService.getValidAccessToken(companyId);
    const question = await this.api.getResource<JsonRecord>(
      session.accessToken,
      `/questions/${questionId}`,
      { api_version: 4 },
    );
    await this.upsertQuestion(companyId, question);
  }

  async answerQuestion(companyId: string, questionId: string, text: string) {
    if (!text.trim()) throw new BadRequestException('Resposta nao informada');
    const session = await this.authService.getValidAccessToken(companyId);
    const response = await this.api.postResource<JsonRecord>(
      session.accessToken,
      '/answers',
      {
        question_id: Number(questionId),
        text: text.trim(),
      },
    );
    await this.syncQuestionById(companyId, questionId);
    return response;
  }

  async syncReviews(companyId: string): Promise<number> {
    const session = await this.authService.getValidAccessToken(companyId);
    try {
      const response = await this.api.getResource<JsonRecord>(
        session.accessToken,
        '/reviews/search',
        { publisher_id: session.mlUserId, limit: 50 },
      );
      const reviews = asRecordArray(response.reviews ?? response.results);
      for (const review of reviews) {
        await this.upsertReview(companyId, review);
      }
      return reviews.length;
    } catch (error) {
      this.logger.warn(`Avaliacoes Mercado Livre indisponiveis: ${(error as Error).message}`);
      return 0;
    }
  }

  async listProducts(companyId: string) {
    const products = await this.prisma.product.findMany({
      where: { companyId, marketplaceProvider: IntegrationProvider.MERCADOLIVRE },
      include: { stock: true },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return products.map((product) => ({
      id: product.id,
      mlItemId: product.mlItemId,
      title: product.name,
      price: Number(product.price),
      status: product.marketplaceStatus,
      stock: product.stock?.quantity ?? product.availableQuantity ?? 0,
      soldQuantity: product.soldQuantity ?? 0,
      permalink: product.marketplacePermalink,
      updatedAt: product.updatedAt.toISOString(),
    }));
  }

  async listOrders(companyId: string) {
    const orders = await this.prisma.mercadoLivreOrder.findMany({
      where: { companyId },
      include: { items: true, shipment: true },
      orderBy: { dateCreated: 'desc' },
      take: 100,
    });
    return orders.map((order) => ({
      id: order.id,
      mlOrderId: order.mlOrderId,
      status: order.status,
      totalAmount: Number(order.totalAmount),
      paidAmount: order.paidAmount ? Number(order.paidAmount) : null,
      currencyId: order.currencyId,
      dateCreated: order.dateCreated.toISOString(),
      items: order.items.map((item) => ({
        title: item.title,
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
      })),
      shipment: order.shipment
        ? {
            status: order.shipment.status,
            trackingCode: order.shipment.trackingCode,
          }
        : null,
    }));
  }

  async listQuestions(companyId: string) {
    const questions = await this.prisma.mercadoLivreQuestion.findMany({
      where: { companyId },
      orderBy: [{ status: 'asc' }, { dateCreated: 'desc' }],
      take: 100,
    });
    return questions.map((question) => ({
      id: question.id,
      mlQuestionId: question.mlQuestionId,
      mlItemId: question.mlItemId,
      status: question.status,
      question: question.question,
      answer: question.answer,
      dateCreated: question.dateCreated?.toISOString() || null,
    }));
  }

  async listReviews(companyId: string) {
    const reviews = await this.prisma.mercadoLivreReview.findMany({
      where: { companyId },
      orderBy: { dateCreated: 'desc' },
      take: 100,
    });
    return reviews.map((review) => ({
      id: review.id,
      mlReviewId: review.mlReviewId,
      rating: review.rating,
      status: review.status,
      title: review.title,
      content: review.content,
      dateCreated: review.dateCreated?.toISOString() || null,
    }));
  }

  async getDashboard(companyId: string) {
    const [ordersAgg, ordersCount, productsCount, pendingQuestions, reviewsAgg] = await Promise.all([
      this.prisma.mercadoLivreOrder.aggregate({
        where: { companyId },
        _sum: { totalAmount: true },
      }),
      this.prisma.mercadoLivreOrder.count({ where: { companyId } }),
      this.prisma.product.count({
        where: { companyId, marketplaceProvider: IntegrationProvider.MERCADOLIVRE },
      }),
      this.prisma.mercadoLivreQuestion.count({
        where: { companyId, status: { in: ['unanswered', 'UNDER_REVIEW', 'under_review'] } },
      }),
      this.prisma.mercadoLivreReview.aggregate({
        where: { companyId, rating: { not: null } },
        _avg: { rating: true },
      }),
    ]);

    return {
      revenue: Number(ordersAgg._sum.totalAmount ?? 0),
      orders: ordersCount,
      products: productsCount,
      pendingQuestions,
      averageRating: Number(reviewsAgg._avg.rating ?? 0),
    };
  }

  private async upsertProduct(companyId: string, item: MercadoLivreProductItem) {
    const product = await this.prisma.product.upsert({
      where: {
        companyId_marketplaceProvider_mlItemId: {
          companyId,
          marketplaceProvider: IntegrationProvider.MERCADOLIVRE,
          mlItemId: item.id,
        },
      },
      update: {
        companyId,
        name: item.title,
        sku: item.seller_custom_field || undefined,
        category: item.category_id || undefined,
        price: new Prisma.Decimal(item.price),
        mlItemId: item.id,
        marketplaceProvider: IntegrationProvider.MERCADOLIVRE,
        marketplaceStatus: item.status || null,
        marketplacePermalink: item.permalink || null,
        currencyId: item.currency_id || 'BRL',
        availableQuantity: item.available_quantity ?? 0,
        soldQuantity: item.sold_quantity ?? 0,
        lastMarketplaceSyncAt: new Date(),
      },
      create: {
        companyId,
        name: item.title,
        sku: item.seller_custom_field || null,
        category: item.category_id || null,
        price: new Prisma.Decimal(item.price),
        mlItemId: item.id,
        marketplaceProvider: IntegrationProvider.MERCADOLIVRE,
        marketplaceStatus: item.status || null,
        marketplacePermalink: item.permalink || null,
        currencyId: item.currency_id || 'BRL',
        availableQuantity: item.available_quantity ?? 0,
        soldQuantity: item.sold_quantity ?? 0,
        lastMarketplaceSyncAt: new Date(),
      },
      select: { id: true },
    });

    await this.prisma.stock.upsert({
      where: { productId: product.id },
      update: {
        companyId,
        provider: IntegrationProvider.MERCADOLIVRE,
        externalId: item.id,
        quantity: item.available_quantity ?? 0,
      },
      create: {
        companyId,
        productId: product.id,
        provider: IntegrationProvider.MERCADOLIVRE,
        externalId: item.id,
        quantity: item.available_quantity ?? 0,
      },
    });
  }

  private async upsertOrder(companyId: string, sellerId: string, order: JsonRecord, userId?: string): Promise<boolean> {
    const mlOrderId = asString(order.id);
    if (!mlOrderId) return false;

    const buyer = asRecord(order.buyer);
    const dateCreated = asDate(order.date_created) || new Date();
    const dateClosed = asDate(order.date_closed);
    const totalAmount = asNumber(order.total_amount);
    const paidAmount = this.extractPaidAmount(order);
    const revenueAmount = paidAmount && paidAmount > 0 ? paidAmount : totalAmount;
    const status = asString(order.status) || 'unknown';
    const shouldCreateRevenue = this.isRevenueOrder(order, status, revenueAmount);
    const resolvedUserId = userId || (await this.resolveUserId(companyId));
    const firstItem = asRecordArray(order.order_items)[0];
    const firstItemData = asRecord(firstItem?.item);
    const productName = asString(firstItemData?.title) || `Pedido ML ${mlOrderId}`;
    const existingOrder = await this.prisma.mercadoLivreOrder.findUnique({
      where: { mlOrderId },
      select: { saleId: true, financialTransactionId: true },
    });

    let saleId = existingOrder?.saleId || null;
    let financialTransactionId = existingOrder?.financialTransactionId || null;
    const metadata = toInputJson({
      mlOrderId,
      status,
      paidAmount,
      externalSource: 'MERCADO_LIVRE',
      provider: 'MERCADO_LIVRE',
    });

    if (shouldCreateRevenue) {
      const sale = await this.prisma.sale.upsert({
        where: {
          companyId_channel_externalId: {
            companyId,
            channel: SaleChannel.mercadolivre,
            externalId: mlOrderId,
          },
        },
        update: {
          amount: new Prisma.Decimal(revenueAmount),
          productName,
          category: 'Mercado Livre',
          occurredAt: dateClosed || dateCreated,
          metadataJson: metadata,
        },
        create: {
          userId: resolvedUserId || null,
          companyId,
          amount: new Prisma.Decimal(revenueAmount),
          productName,
          category: 'Mercado Livre',
          channel: SaleChannel.mercadolivre,
          externalId: mlOrderId,
          occurredAt: dateClosed || dateCreated,
          metadataJson: metadata,
        },
        select: { id: true },
      });
      saleId = sale.id;

      const transaction = await this.prisma.financialTransaction.upsert({
        where: {
          companyId_source_externalId: {
            companyId,
            source: 'mercadolivre',
            externalId: mlOrderId,
          },
        },
        update: {
          amount: new Prisma.Decimal(revenueAmount),
          description: `Mercado Livre pedido ${mlOrderId}`,
          category: 'Marketplace',
          date: dateClosed || dateCreated,
          occurredAt: dateClosed || dateCreated,
          metadataJson: metadata,
        },
        create: {
          companyId,
          userId: resolvedUserId || null,
          type: FinancialTransactionType.INCOME,
          amount: new Prisma.Decimal(revenueAmount),
          description: `Mercado Livre pedido ${mlOrderId}`,
          category: 'Marketplace',
          source: 'mercadolivre',
          externalId: mlOrderId,
          date: dateClosed || dateCreated,
          occurredAt: dateClosed || dateCreated,
          metadataJson: metadata,
        },
        select: { id: true },
      });
      financialTransactionId = transaction.id;
    } else {
      await this.zeroRevenueRecords(saleId, financialTransactionId, metadata);
    }

    const storedOrder = await this.prisma.mercadoLivreOrder.upsert({
      where: { mlOrderId },
      update: {
        companyId,
        sellerId,
        buyerId: asString(buyer?.id),
        status,
        currencyId: asString(order.currency_id),
        totalAmount: new Prisma.Decimal(totalAmount),
        paidAmount: paidAmount === null ? null : new Prisma.Decimal(paidAmount),
        dateCreated,
        dateClosed,
        saleId,
        financialTransactionId,
        rawPayload: toInputJson(order),
      },
      create: {
        companyId,
        mlOrderId,
        sellerId,
        buyerId: asString(buyer?.id),
        status,
        currencyId: asString(order.currency_id),
        totalAmount: new Prisma.Decimal(totalAmount),
        paidAmount: paidAmount === null ? null : new Prisma.Decimal(paidAmount),
        dateCreated,
        dateClosed,
        saleId,
        financialTransactionId,
        rawPayload: toInputJson(order),
      },
      select: { id: true },
    });

    await this.upsertOrderItems(companyId, storedOrder.id, order);
    await this.upsertShipment(companyId, storedOrder.id, order);
    return shouldCreateRevenue;
  }

  private async upsertOrderItems(companyId: string, orderId: string, order: JsonRecord) {
    const items = asRecordArray(order.order_items);
    await this.prisma.mercadoLivreOrderItem.deleteMany({ where: { orderId } });

    for (const row of items) {
      const item = asRecord(row.item);
      const mlItemId = asString(item?.id);
      if (!mlItemId) continue;
      const product = await this.prisma.product.findFirst({
        where: {
          companyId,
          mlItemId,
          marketplaceProvider: IntegrationProvider.MERCADOLIVRE,
        },
        select: { id: true },
      });
      await this.prisma.mercadoLivreOrderItem.create({
        data: {
          companyId,
          orderId,
          productId: product?.id,
          mlItemId,
          title: asString(item?.title) || 'Produto Mercado Livre',
          quantity: asInteger(row.quantity, 1),
          unitPrice: toDecimal(row.unit_price),
          fullUnitPrice: row.full_unit_price === undefined ? null : toDecimal(row.full_unit_price),
          currencyId: asString(row.currency_id),
          rawPayload: toInputJson(row),
        },
      });
    }
  }

  private async upsertShipment(companyId: string, orderId: string, order: JsonRecord) {
    const shipping = asRecord(order.shipping);
    if (!shipping) return;
    const mlShipmentId = asString(shipping?.id);
    if (!mlShipmentId) return;

    await this.upsertShipmentRecord(companyId, orderId, mlShipmentId, shipping);
  }

  private async upsertShipmentRecord(
    companyId: string,
    orderId: string,
    mlShipmentId: string,
    shipping: JsonRecord,
  ) {
    await this.prisma.mercadoLivreShipment.upsert({
      where: { mlShipmentId },
      update: {
        companyId,
        orderId,
        status: asString(shipping?.status),
        substatus: asString(shipping?.substatus),
        logisticType: asString(shipping?.logistic_type),
        trackingCode: asString(shipping?.tracking_number) || asString(shipping?.tracking_code),
        receiverName: asString(asRecord(shipping?.receiver_address)?.receiver_name),
        rawPayload: toInputJson(shipping),
      },
      create: {
        companyId,
        orderId,
        mlShipmentId,
        status: asString(shipping?.status),
        substatus: asString(shipping?.substatus),
        logisticType: asString(shipping?.logistic_type),
        trackingCode: asString(shipping?.tracking_number) || asString(shipping?.tracking_code),
        receiverName: asString(asRecord(shipping?.receiver_address)?.receiver_name),
        rawPayload: toInputJson(shipping),
      },
    });
  }

  private async upsertQuestion(companyId: string, question: JsonRecord) {
    const mlQuestionId = asString(question.id);
    if (!mlQuestionId) return;
    const answer = asRecord(question.answer);
    const mlItemId = asString(question.item_id);
    const product = mlItemId
      ? await this.prisma.product.findFirst({
          where: {
            companyId,
            mlItemId,
            marketplaceProvider: IntegrationProvider.MERCADOLIVRE,
          },
          select: { id: true },
        })
      : null;

    await this.prisma.mercadoLivreQuestion.upsert({
      where: { mlQuestionId },
      update: {
        companyId,
        productId: product?.id,
        mlItemId,
        sellerId: asString(question.seller_id),
        status: asString(question.status),
        question: asString(question.text ?? question.question) || '',
        answer: asString(answer?.text),
        dateCreated: asDate(question.date_created),
        answerDateCreated: asDate(answer?.date_created),
        rawPayload: toInputJson(question),
      },
      create: {
        companyId,
        productId: product?.id,
        mlQuestionId,
        mlItemId,
        sellerId: asString(question.seller_id),
        status: asString(question.status),
        question: asString(question.text ?? question.question) || '',
        answer: asString(answer?.text),
        dateCreated: asDate(question.date_created),
        answerDateCreated: asDate(answer?.date_created),
        rawPayload: toInputJson(question),
      },
    });
  }

  private async upsertReview(companyId: string, review: JsonRecord) {
    const mlReviewId = asString(review.id) || asString(review.review_id);
    if (!mlReviewId) return;
    const orderId = asString(review.order_id);
    const order = orderId
      ? await this.prisma.mercadoLivreOrder.findUnique({ where: { mlOrderId: orderId }, select: { id: true } })
      : null;

    await this.prisma.mercadoLivreReview.upsert({
      where: { mlReviewId },
      update: {
        companyId,
        orderId: order?.id,
        rating: review.rating === undefined ? null : asInteger(review.rating),
        status: asString(review.status),
        title: asString(review.title),
        content: asString(review.content ?? review.comment),
        dateCreated: asDate(review.date_created),
        rawPayload: toInputJson(review),
      },
      create: {
        companyId,
        orderId: order?.id,
        mlReviewId,
        rating: review.rating === undefined ? null : asInteger(review.rating),
        status: asString(review.status),
        title: asString(review.title),
        content: asString(review.content ?? review.comment),
        dateCreated: asDate(review.date_created),
        rawPayload: toInputJson(review),
      },
    });
  }

  private extractPaidAmount(order: JsonRecord): number | null {
    const payments = asRecordArray(order.payments);
    if (!payments.length) return null;
    return payments.reduce((total, payment) => total + asNumber(payment.total_paid_amount ?? payment.transaction_amount), 0);
  }

  private isRevenueOrder(order: JsonRecord, status: string, amount: number) {
    if (amount <= 0) return false;
    const normalizedStatus = status.trim().toLowerCase();
    if (
      [
        'cancelled',
        'canceled',
        'refunded',
        'charged_back',
        'payment_required',
        'payment_in_process',
      ].includes(normalizedStatus)
    ) {
      return false;
    }

    const payments = asRecordArray(order.payments);
    const approvedPayment = payments.some((payment) =>
      ['approved', 'paid', 'accredited'].includes(
        String(payment.status || payment.status_detail || '').trim().toLowerCase(),
      ),
    );
    return approvedPayment || ['paid', 'confirmed', 'closed'].includes(normalizedStatus);
  }

  private async zeroRevenueRecords(
    saleId: string | null,
    financialTransactionId: string | null,
    metadata: Prisma.InputJsonValue,
  ) {
    await Promise.all([
      saleId
        ? this.prisma.sale.update({
            where: { id: saleId },
            data: { amount: new Prisma.Decimal(0), metadataJson: metadata },
          })
        : Promise.resolve(),
      financialTransactionId
        ? this.prisma.financialTransaction.update({
            where: { id: financialTransactionId },
            data: { amount: new Prisma.Decimal(0), metadataJson: metadata },
          })
        : Promise.resolve(),
    ]);
  }

  private async resolveUserId(companyId: string): Promise<string | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { userId: true, users: { select: { id: true }, take: 1 } },
    });
    const userId = company?.userId || company?.users[0]?.id;
    if (!userId) {
      this.logger.warn(
        JSON.stringify({
          event: 'mercado_livre.sync.company_without_owner',
          companyId,
        }),
      );
      return null;
    }
    return userId;
  }

  private async refreshAnalytics(companyId: string) {
    const dashboard = await this.getDashboard(companyId);
    await this.prisma.mercadoLivreAnalytics.deleteMany({
      where: { companyId, metricKey: { in: ['revenue', 'orders', 'products', 'pending_questions', 'average_rating'] } },
    });
    await this.prisma.mercadoLivreAnalytics.createMany({
      data: [
        { companyId, metricKey: 'revenue', value: toInputJson(dashboard.revenue) },
        { companyId, metricKey: 'orders', value: toInputJson(dashboard.orders) },
        { companyId, metricKey: 'products', value: toInputJson(dashboard.products) },
        { companyId, metricKey: 'pending_questions', value: toInputJson(dashboard.pendingQuestions) },
        { companyId, metricKey: 'average_rating', value: toInputJson(dashboard.averageRating) },
      ],
    });
  }
}
