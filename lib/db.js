import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "./env.js";

export const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Hackathon evidence: every AI decision, timestamped.
export const log = (vendor_id, conversation_id, action, detail) =>
  db.from("agent_logs").insert({ vendor_id, conversation_id, action, detail }).then(() => {});
