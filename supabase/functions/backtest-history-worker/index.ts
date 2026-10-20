import { createBacktestHistoryWorker } from "./worker.mjs";

// Prefer the current secret-key environment; retain legacy platform compatibility.
let secretKey = "";
try { secretKey = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ?? ""; }
catch { /* An invalid new-key configuration falls back to the platform legacy key. */ }
Deno.serve(createBacktestHistoryWorker({
  supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
  serviceRoleKey: secretKey || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
}));
