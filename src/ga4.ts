import axios from 'axios';
import { logToSheet } from './logger';

// Функция для извлечения кастомных полей
function extractCustomField(data: any, fieldName: string) {
    const field = data.custom_fields?.find((f: any) => f.name === fieldName || f.uuid === fieldName);
    return field ? field.value : null;
}

// Пример хелпера источника
function extractSource(sourceId: number) {
   const map: Record<number, string> = { 1: 'website_form', 2: 'incoming_call', 3: 'chat_binotel' };
   return map[sourceId] || 'other';
}

import * as crypto from 'crypto';

export async function sendToGA4(eventType: string, crmData: any) {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;
  
  if (!measurementId || !apiSecret) {
    throw new Error('GA4_MEASUREMENT_ID and GA4_API_SECRET are required in .env');
  }

  const endpoint = `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`;

  // Генеруємо фейковий client_id якщо його не знайдено (вимога з ТЗ)
  let clientId = crmData.client_id;
  if (!clientId || clientId === 'unknown-client') {
    clientId = crypto.randomUUID();
  }

  // Формуємо user_properties з utm міток
  const userProperties: any = {};
  if (crmData.utm_source) userProperties.traffic_source = { value: crmData.utm_source };
  if (crmData.utm_medium) userProperties.traffic_medium = { value: crmData.utm_medium };
  if (crmData.utm_campaign) userProperties.campaign_name = { value: crmData.utm_campaign };

  // Основний payload для GA4
  const ga4Payload: any = {
    client_id: clientId, 
    timestamp_micros: (Date.now() * 1000).toString(),
    user_properties: Object.keys(userProperties).length ? userProperties : undefined,
    events: []
  };

  const items = (crmData.products || []).map((prod: any) => ({
    item_id: prod.sku || prod.id || '',
    item_name: prod.name || '',
    price: parseFloat(prod.price || 0),
    quantity: prod.quantity || 1
  }));

  if (eventType === 'lead') {
    ga4Payload.events.push({
      name: 'lead',
      params: {
        lead_id: crmData.id?.toString(),
        lead_source: extractCustomField(crmData, 'OR_1001') || extractSource(crmData.source_id),
        lead_handled: 'auto_website', // або з додаткових полів
        checkout_type: extractCustomField(crmData, 'OR_1003') || 'standard',
        value: parseFloat(crmData.grand_total || crmData.total || 0),
        currency: 'UAH',
        campaign: crmData.utm_campaign || '',
        source: crmData.utm_source || '',
        medium: crmData.utm_medium || '',
        items
      }
    });
  }

  if (eventType === 'purchase') {
    ga4Payload.events.push({
      name: 'purchase',
      params: {
        transaction_id: crmData.transaction_id || crmData.id?.toString(),
        lead_id: crmData.id?.toString(),
        value: parseFloat(crmData.grand_total || 0),
        shipping: parseFloat(crmData.shipping_price || 0),
        currency: 'UAH',
        payment_type: crmData.payment_method?.name || '',
        shipping_tier: crmData.delivery_service?.name || '',
        checkout_type: extractCustomField(crmData, 'OR_1003'),
        gclid: extractCustomField(crmData, 'OR_1011'),
        items
      }
    });
  }

  if (eventType === 'refund') {
    ga4Payload.events.push({
      name: 'refund',
      params: {
        transaction_id: crmData.transaction_id || crmData.id?.toString(),
        lead_id: crmData.id?.toString(),
        value: parseFloat(crmData.grand_total || 0),
        currency: 'UAH',
        cancellation_reason: extractCustomField(crmData, 'OR_1009') || extractCustomField(crmData, 'cancellation_reason') || 'unknown', 
        cancellation_stage: extractCustomField(crmData, 'OR_1014') || extractCustomField(crmData, 'cancellation_stage') || 'unknown',
        items
      }
    });
  }

  const response = await axios.post(endpoint, ga4Payload);
  console.log(`[GA4 Response] ${eventType} for ${crmData.transaction_id}: HTTP ${response.status}`);
  
  // Пишем в Google Таблицу (Лист 2)
  await logToSheet('GA4_Measurement', {
    id: crmData.transaction_id,
    eventType: eventType,
    client_id: crmData.client_id,
    payload: ga4Payload
  });

  return response.data;
}
