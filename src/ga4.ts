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
   return map[sourceId] || undefined;
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

  const utmSource = crmData.utm_source || crmData.source?.utm_source || extractCustomField(crmData, 'utm_source');
  const utmMedium = crmData.utm_medium || crmData.source?.utm_medium || extractCustomField(crmData, 'utm_medium');
  const utmCampaign = crmData.utm_campaign || crmData.source?.utm_campaign || extractCustomField(crmData, 'utm_campaign');

  // Формуємо user_properties з utm міток
  const userProperties: any = {};
  if (utmSource) userProperties.traffic_source = { value: utmSource };
  if (utmMedium) userProperties.traffic_medium = { value: utmMedium };
  if (utmCampaign) userProperties.campaign_name = { value: utmCampaign };

  // Основний payload для GA4
  const ga4Payload: any = {
    client_id: clientId, 
    timestamp_micros: Date.now() * 1000,
    user_properties: Object.keys(userProperties).length ? userProperties : undefined,
    events: []
  };

  const items = (crmData.products || []).map((prod: any) => ({
    item_id: prod.sku || prod.id || '',
    item_name: prod.name || '',
    quantity: prod.quantity || 1,
    price: parseFloat(prod.price || 0)
  }));

  const transactionIdNum = crmData.transaction_id || crmData.id;

  if (eventType === 'lead') {
    let leadHandledVal = extractCustomField(crmData, 'lead_handled') || 'auto_website';
    let checkoutTypeVal = extractCustomField(crmData, 'OR_1003') || extractCustomField(crmData, 'checkout_type') || 'standard';
    let leadSourceVal = extractCustomField(crmData, 'OR_1001') || extractCustomField(crmData, 'lead_source') || extractSource(crmData.source_id);

    // Override specifically for pipelines 1 and 2 (Звонки, Меседжеры)
    if (crmData.pipeline_id === 1 || crmData.pipeline_id === 2) {
      leadSourceVal = extractCustomField(crmData, 'LD_1012') || extractCustomField(crmData, 'lead_source_v') || leadSourceVal;
      leadHandledVal = extractCustomField(crmData, 'LD_1013') || extractCustomField(crmData, 'lead_handled_v') || leadHandledVal;
      checkoutTypeVal = extractCustomField(crmData, 'LD_1015') || extractCustomField(crmData, 'status_lead') || checkoutTypeVal;
    }

    const leadParams: any = {
      transaction_id: transactionIdNum,
      lead_id: crmData.id,
      value: parseFloat(crmData.grand_total || crmData.total || crmData.payments_total || crmData.price || 0),
      currency: 'UAH',
      items,
      lead_handled: leadHandledVal,
      checkout_type: checkoutTypeVal,
      debug_mode: 1,
      engagement_time_msec: 1
    };

    if (leadSourceVal) {
      leadParams.lead_source = leadSourceVal;
    }

    ga4Payload.events.push({
      name: 'lead',
      params: leadParams
    });
  }

  if (eventType === 'purchase') {
    ga4Payload.events.push({
      name: 'purchase',
      params: {
        transaction_id: transactionIdNum,
        lead_id: crmData.id,
        value: parseFloat(crmData.grand_total || 0),
        shipping: parseFloat(crmData.shipping_price || 0),
        currency: 'UAH',
        payment_type: crmData.payment_method?.name || '',
        shipping_tier: crmData.delivery_service?.name || '',
        checkout_type: extractCustomField(crmData, 'OR_1003') || extractCustomField(crmData, 'checkout_type'),
        gclid: extractCustomField(crmData, 'OR_1011') || extractCustomField(crmData, 'gclid'),
        items,
        debug_mode: 1,
        engagement_time_msec: 1
      }
    });
  }

  if (eventType === 'refund') {
    ga4Payload.events.push({
      name: 'refund',
      params: {
        transaction_id: transactionIdNum,
        lead_id: crmData.id,
        value: parseFloat(crmData.grand_total || 0),
        currency: 'UAH',
        cancelation_reason: extractCustomField(crmData, 'OR_1009') || extractCustomField(crmData, 'cancellation_reason') || extractCustomField(crmData, 'cancelation_reason') || 'unknown', 
        cancellation_stage: extractCustomField(crmData, 'OR_1014') || extractCustomField(crmData, 'cancellation_stage') || 'unknown',
        items,
        debug_mode: 1,
        engagement_time_msec: 1
      }
    });
  }

  const response = await axios.post(endpoint, ga4Payload);
  console.log(`[GA4 Response] ${eventType} for ${transactionIdNum}: HTTP ${response.status}`);
  
  // Пишем в Google Таблицу (Лист 2)
  await logToSheet('GA4_Measurement', {
    id: transactionIdNum,
    eventType: eventType,
    client_id: clientId,
    status: `Sent OK (HTTP ${response.status})`,
    payload: ga4Payload
  });

  return response.data;
}
