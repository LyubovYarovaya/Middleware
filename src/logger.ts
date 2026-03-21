import axios from 'axios';

const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_WRITER_URL;

export async function logToSheet(sheetName: string, data: any) {
  if (!GOOGLE_SHEET_URL) return;
  
  try {
    await axios.post(GOOGLE_SHEET_URL, {
      sheetName,
      ...data
    });
    console.log(`[Google Sheets] Recorded to ${sheetName} for ID ${data.id || 'N/A'}`);
  } catch (error: any) {
    console.error(`[Error] Failed to log to sheet ${sheetName}:`, error.message);
  }
}
