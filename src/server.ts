import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { ga4Queue, redis } from './queue';
import { logToSheet } from './logger';

const app = express();
app.use(express.json());

const KEYCRM_API_KEY = process.env.KEYCRM_API_KEY;

async function fetchFullOrderById(orderId: number | string) {
  try {
    const response = await axios.get(`https://openapi.keycrm.app/v1/order/${orderId}?include=buyer,products,custom_fields`, {
      headers: { 'Authorization': `Bearer ${KEYCRM_API_KEY}`, 'Accept': 'application/json' }
    });
    return response.data;
  } catch (error: any) {
    // console.error(`[Error] Failed to fetch order by ID ${orderId}:`, error.message);
    return null;
  }
}

async function fetchPipelineCardById(cardId: number | string) {
  try {
    const response = await axios.get(`https://openapi.keycrm.app/v1/pipelines/cards/${cardId}?include=contact,products,custom_fields`, {
      headers: { 'Authorization': `Bearer ${KEYCRM_API_KEY}`, 'Accept': 'application/json' }
    });
    return response.data;
  } catch (error: any) {
    return null;
  }
}

async function fetchFullOrderBySource(sourceUuid: string, sourceId?: number | string) {
  try {
    let url = `https://openapi.keycrm.app/v1/orders?filter[source_uuid]=${sourceUuid}&include=buyer,products,custom_fields`;
    if (sourceId) {
      url += `&filter[source_id]=${sourceId}`;
    }
    const response = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${KEYCRM_API_KEY}`, 'Accept': 'application/json' }
    });
    // Повертаємо перше знайдене замовлення
    return response.data?.data?.[0] || null;
  } catch (error: any) {
    // console.error(`[Error] Failed to fetch order by source_uuid ${sourceUuid}:`, error.message);
    return null;
  }
}

function extractCustomField(data: any, fieldName: string) {
    const field = data.custom_fields?.find((f: any) => f.name === fieldName || f.uuid === fieldName);
    return field ? field.value : null;
}

app.post('/webhooks/keycrm', async (req, res) => {
  res.status(200).send('OK');

  const data = req.body;
  console.log('[Webhook Received]', JSON.stringify(data));

  // Extract core identifiers
  const initialData = data.context || data;
  const eventName = data.event || data.context?.event || 'order.created';
  
  const internalId = initialData.id || initialData.order_id;
  const sourceUuid = initialData.source_uuid;
  const sourceId = initialData.source_id;

  // Завжди записуємо початковий вебхук в таблицю, щоб бачити що прийшло, навіть якщо потім буде помилка API
  await logToSheet('Webhooks', {
    event_time: new Date().toISOString(),
    id: internalId || sourceUuid || 'unknown',
    event: eventName,
    full_json: initialData // запис сирого вебхука на випадок помилок
  });

  // Вирішуємо конфлікт: якщо немає внутрішнього ID, шукаємо через source_uuid
  let fullOrderData: any = null;
  if (internalId) {
    if (eventName.includes('pipeline') || eventName.includes('card')) {
      fullOrderData = await fetchPipelineCardById(internalId);
    } else {
      // It could be an order event, or an ambiguous event missing an eventName
      const orderCandidate = await fetchFullOrderById(internalId);
      const cardCandidate = await fetchPipelineCardById(internalId);

      const getTime = (obj: any) => new Date(obj?.updated_at || obj?.created_at || 0).getTime();
      
      const orderTime = getTime(orderCandidate);
      const cardTime = getTime(cardCandidate);
      
      // Heuristic: Whichever entity was updated closer to right NOW is the one that triggered the webhook.
      // Usually, Webhooks fire within seconds of the entity update.
      const now = Date.now();
      const orderDiff = orderCandidate ? Math.abs(now - orderTime) : Infinity;
      const cardDiff = cardCandidate ? Math.abs(now - cardTime) : Infinity;

      if (orderCandidate && cardCandidate) {
        fullOrderData = cardDiff < orderDiff ? cardCandidate : orderCandidate;
      } else {
        fullOrderData = orderCandidate || cardCandidate;
      }
    }
  } else if (sourceUuid) {
    console.log(`[Warning] No internal ID found in webhook. Searching by source_uuid: ${sourceUuid}`);
    fullOrderData = await fetchFullOrderBySource(sourceUuid, sourceId);
  }

  if (!fullOrderData) {
    console.log(`[Abort] Could not fetch full data for webhook. Skipping GA4...`);
    return;
  }

  const transactionId = fullOrderData.id;
  const orderStatus = fullOrderData.status_id;
  // OR_1004 - системне ім'я поля ga_client_id
  let clientId = extractCustomField(fullOrderData, 'OR_1004') || extractCustomField(fullOrderData, 'ga_client_id'); 
  if (!clientId || clientId === 'unknown-client') {
    clientId = randomUUID();
  }

  console.log(`[Order Processing] ID: ${transactionId}, Status: ${orderStatus}, Event: ${eventName}, Client: ${clientId}`);

  // Оновлюємо рядок в Google Таблиці з повними даними
  await logToSheet('Webhooks', {
    event_time: fullOrderData.updated_at || fullOrderData.created_at || new Date().toISOString(),
    id: transactionId,
    status: orderStatus,
    event: eventName,
    value: parseFloat(fullOrderData.grand_total || fullOrderData.payments_total || fullOrderData.price || 0),
    client_id: clientId,
    full_json: fullOrderData
  });

  let evType = null;
  if (orderStatus === 1 || eventName.includes('lead.created') || eventName.includes('pipeline.card') || fullOrderData.pipeline_id) {
    evType = 'lead';
  } else if (orderStatus === 23 || orderStatus === 24) {
    evType = 'purchase';
  } else if (orderStatus === 19) {
    evType = 'refund';
  }

  if (evType) {
    // Дедуплікація: забороняємо відправку того ж типу події більше 1 разу на 30 днів
    const setRes = await redis.set(`dedup:${evType}:${transactionId}`, 'locked', 'EX', 86400 * 30, 'NX');
    let canSend: boolean = (setRes === 'OK');
    
    // Якщо це refund, додатково перевіряємо, чи був purchase
    if (evType === 'refund' && canSend) {
      const wasPurchaseSent = await redis.get(`ga4_success:${transactionId}`);
      if (!wasPurchaseSent) canSend = false; // не можна скасувати те, що не передавалось
    }

    if (canSend) {
      console.log(`[Queue] Adding ${evType} for ${transactionId} to GA4 Queue.`);
      await ga4Queue.add('send-ga4', {
        eventType: evType,
        payload: { ...fullOrderData, client_id: clientId, transaction_id: transactionId }
      }, { 
        attempts: 4, backoff: { type: 'customInterval' } 
      });

      // --- ДОДАНА ТАБЛИЦЯ ДЛЯ ОФЛАЙН КОНВЕРСІЙ GOOGLE РЕКЛАМИ ---
      if (evType === 'lead' || evType === 'purchase') {
        const offset = -new Date().getTimezoneOffset();
        const sign = offset >= 0 ? '+' : '-';
        const pad = (num: number) => num.toString().padStart(2, '0');
        const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
        const offsetMins = pad(Math.abs(offset) % 60);
        
        const date = new Date(fullOrderData.updated_at || fullOrderData.created_at || Date.now());
        const formattedTime = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${offsetHours}${offsetMins}`;

        const checkoutType = extractCustomField(fullOrderData, 'OR_1003') || extractCustomField(fullOrderData, 'checkout_type') || '';
        const sourceName = String(fullOrderData.source?.name || '').toLowerCase();
        
        let conversionName = '';

        if (checkoutType.includes('Купити в один клік')) {
          conversionName = 'Купити в один клік';
        } else if (checkoutType.includes('Оплата частинами ПриватБанк') || checkoutType.includes('Оплата частинами МоноБанк')) {
          conversionName = 'Оплата частинами';
        } else if (fullOrderData.pipeline_id === 1 || sourceName.includes('дзвінк') || sourceName.includes('звонк') || fullOrderData.source_id === 2) {
          conversionName = 'Звонки';
        } else if (fullOrderData.pipeline_id === 2 || sourceName.includes('месенджер') || sourceName.includes('мессенджер') || sourceName.includes('меседжер') || sourceName.includes('telegram') || sourceName.includes('viber')) {
          conversionName = 'Меседжеры';
        } else {
          conversionName = 'Other'; 
        }

        const getStrField = (id1: string, id2?: string) => {
          const val = extractCustomField(fullOrderData, id1) || (id2 ? extractCustomField(fullOrderData, id2) : null);
          if (Array.isArray(val)) return val.join(', ');
          return val || '';
        };

        const gAdsPayload: any = {
          conversion_name: conversionName,
          conversion_event_time: formattedTime,
          gclid: getStrField('OR_1011', 'gclid'),
          currency_code: 'UAH',
          order_id: transactionId,
          gbraid: getStrField('gbraid'),
          wbraid: getStrField('wbraid'),
          conversion_value: parseFloat(fullOrderData.grand_total || fullOrderData.total || fullOrderData.payments_total || fullOrderData.price || 0),
          'Агент пользователя (User Agent)': getStrField('user_agent'),
          'IP-адрес': getStrField('ip'),
          'Атрибуты сеанса (Session attributes)': `client_id=${clientId}`
        };

        const statusLeadVal = getStrField('LD_1015', 'status_lead');
        if (statusLeadVal) {
          gAdsPayload.status_lead = statusLeadVal;
        }

        await logToSheet('GoogleAds', gAdsPayload);
      }

    } else {
      console.log(`[Deduplication] Event ${evType} for ${transactionId} skipped (already sent or invalid state).`);
      await logToSheet('GA4_Measurement', {
        id: transactionId,
        eventType: evType,
        client_id: clientId,
        status: 'Skipped (Deduplicated or Invalid Setup)'
      });
    }
  } else {
    console.log(`[Skip] Status ${orderStatus} is not mapped to any GA4 event.`);
    await logToSheet('GA4_Measurement', {
      id: transactionId,
      eventType: `Ignored_Status_${orderStatus}`,
      client_id: clientId,
      status: `Skipped (No GA4 mapping for status ${orderStatus})`
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Middleware started on port ${PORT}`));
