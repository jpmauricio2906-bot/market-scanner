import { createMarketHistoryWorker } from "./worker.mjs";

// Platform credentials stay inside the Edge runtime. Cron uses its own Vault token.
Deno.serve(createMarketHistoryWorker({
  supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
}));
