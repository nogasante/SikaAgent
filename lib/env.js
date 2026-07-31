// Central env access so no module reaches into process.env directly.
export const {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  GEMINI_API_KEY, PAYSTACK_SECRET,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  CRON_SECRET = "change-me",
  // Twilio Content templates for WhatsApp buttons. Unset = plain-text fallback.
  CONTENT_SID_PAY_NOW,
  CONTENT_SID_DEMO_PAY,
  CONTENT_SID_CHOOSE_2,
  CONTENT_SID_CHOOSE_3,
  ADMIN_PASSWORD,
  SESSION_SECRET = "change-me",
  PORT = 8080,
} = process.env;
