# KeyCRM to Google Analytics 4 (GA4) Middleware

Цей сервіс є проміжним шаром між **KeyCRM** та **Google Analytics 4**. Він отримує вебхуки від KeyCRM, обробляє їх і відправляє відповідні події у GA4 через Measurement Protocol. Також сервіс веде детальний лог усіх подій у Google Таблиці для моніторингу та відладки.

## 🚀 Основні функції

1.  **Автоматична відправка подій у GA4**:
    *   **Lead**: Трігериться при статусі замовлення `1` (Новий).
    *   **Purchase**: Трігериться при статусі замовлення `23` (Оплачено) чи `24` (Підтверджено).
    *   **Refund**: Трігериться при статусі замовлення `19` (Скасовано).
2.  **Логування у Google Таблиці**:
    *   **Лист "Webhooks"**: Повний дамп вхідних даних від KeyCRM (включаючи `full_json`).
    *   **Лист "GA4_Measurement"**: Лог успішно відправлених запитів у Google Analytics із переданим `payload`.
3.  **Надійність**:
    *   Використання черги (BullMQ) для гарантованої доставки.
    *   Дедуплікація (Redis), щоб уникнути повторних транзакцій `purchase`.

## ⚙️ Налаштування оточення (.env)

У файлі `.env` повинні бути вказані наступні ключі:

```env
PORT=3000
REDIS_HOST=...
REDIS_PORT=...
REDIS_PASSWORD=...

# GA4 Credentials
GA4_MEASUREMENT_ID=...
GA4_API_SECRET=...

# KeyCRM API Key
KEYCRM_API_KEY=...

# Google Sheet Writer URL (URL вашого розгорнутого скрипта)
GOOGLE_SHEET_WRITER_URL=...
```

## 📊 Мапінг кастомних полів (KeyCRM)

Middleware використовує системні імена полів KeyCRM для витягнення даних:

*   **OR_1004 / ga_client_id**: Google ClientID (обов’язково для GA4).
*   **OR_1011**: gclid (Google Click ID) для атрибуції.
*   **OR_1003**: Тип чекаута (checkout_type).
*   **OR_1001**: Джерело ліда (lead_source).
*   **OR_1009**: Причина скасування (для рефандів).

## 🛠 Налаштування Google Apps Script

Для роботи логування у Google Таблиці, необхідно створити скрипт (**Extensions -> Apps Script**) і вставити наступний код:

```javascript
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetName = data.sheetName || 'Webhooks';
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) { sheet = ss.insertSheet(sheetName); }

    let headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
    if (!headers[0]) {
      headers = ['timestamp'];
      sheet.getRange(1, 1).setValue('timestamp');
    }

    const keys = Object.keys(data).filter(k => k !== 'sheetName');
    keys.forEach(key => {
      if (headers.indexOf(key) === -1) {
        sheet.getRange(1, headers.length + 1).setValue(key);
        headers.push(key);
      }
    });

    const row = headers.map(header => {
      if (header === 'timestamp') return new Date();
      const val = data[header];
      if (typeof val === 'object' && val !== null) { return JSON.stringify(val, null, 2); }
      return (val === null || val === undefined) ? '' : val;
    });

    sheet.appendRow(row);
    sheet.getRange(sheet.getLastRow(), 1, 1, headers.length).setWrap(true);
    return ContentService.createTextOutput("Success");
  } catch (err) {
    return ContentService.createTextOutput("Error: " + err.message);
  }
}
```

Не забудьте зробити **Deploy -> New Version** після кожного оновлення скрипта.

## 📦 Розгортання

Проект підготовлений для розгортання на **Railway** (автоматично підхоплює `Procfile` або `npm start`). 
Необхідно підключити Redis (можна як додаток у самому Railway).
