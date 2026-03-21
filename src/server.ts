import 'dotenv/config';
import express from 'express';
import axios from 'axios';
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
    console.error(`[Error] Failed to fetch order by ID ${orderId}:`, error.message);
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
    console.error(`[Error] Failed to fetch order by source_uuid ${sourceUuid}:`, error.message);
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

  // Вирішуємо конфлікт: якщо немає внутрішнього ID, шукаємо через source_uuid
  let fullOrderData = null;
  if (internalId) {
    fullOrderData = await fetchFullOrderById(internalId);
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
  const clientId = extractCustomField(fullOrderData, 'OR_1004') || extractCustomField(fullOrderData, 'ga_client_id') || 'unknown-client'; 

  console.log(`[Order Processing] ID: ${transactionId}, Status: ${orderStatus}, Event: ${eventName}, Client: ${clientId}`);

  // Пишем каждое событие в Google Таблицу (Лист 1)
  await logToSheet('Webhooks', {
    event_time: fullOrderData.updated_at || fullOrderData.created_at || new Date().toISOString(),
    id: transactionId,
    status: orderStatus,
    event: eventName,
    value: parseFloat(fullOrderData.grand_total || 0),
    client_id: clientId,
    full_json: fullOrderData // Відправляємо як об'єкт, щоб Google Apps Script його красиво відформатував
  });

  let evType = null;
  if (orderStatus === 1 || eventName === 'lead.created') {
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
