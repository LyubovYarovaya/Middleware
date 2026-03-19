import axios from 'axios';

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

export async function sendToGA4(eventType: string, crmData: any) {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;
  
  if (!measurementId || !apiSecret) {
    throw new Error('GA4_MEASUREMENT_ID and GA4_API_SECRET are required in .env');
  }

  const endpoint = `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`;

  // Формируем payload для GA4
  const ga4Payload: any = {
    client_id: crmData.client_id, 
    timestamp_micros: (Date.now() * 1000).toString(),
    events: []
  };

  const items = (crmData.products || []).map((prod: any) => ({
    item_id: prod.sku || prod.id,
    item_name: prod.name,
    price: parseFloat(prod.price),
    quantity: prod.quantity
  }));

  if (eventType === 'lead') {
    ga4Payload.events.push({
      name: 'lead',
      params: {
        lead_id: crmData.id,
        lead_source: extractSource(crmData.source_id),
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
        transaction_id: crmData.transaction_id,
        value: parseFloat(crmData.grand_total),
        currency: 'UAH',
        shipping: parseFloat(crmData.shipping_price || 0),
        payment_type: crmData.payment_method?.name || '',
        items
      }
    });
  }

  if (eventType === 'refund') {
    ga4Payload.events.push({
      name: 'refund',
      params: {
        transaction_id: crmData.transaction_id,
        cancellation_reason: extractCustomField(crmData, 'cancellation_reason'), 
        cancellation_stage: extractCustomField(crmData, 'cancellation_stage')
      }
    });
  }

  const response = await axios.post(endpoint, ga4Payload);
  console.log(`[GA4 Response] ${eventType} for ${crmData.transaction_id}: HTTP ${response.status}`);
  
  return response.data;
}
