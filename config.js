/* Supabase address for the page. The anon key is public by design: it grants
   nothing on its own, because every table refuses a request that carries no
   session. scripts/test_rls.py proves that, and must pass before this page goes
   to a public host. Settings can override both values on one device. */
window.JW_SUPABASE = {
  url: "https://qqxuuhfydhazxszqrfst.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxeHV1aGZ5ZGhhenhzenFyZnN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3MDcxNjEsImV4cCI6MjEwNjI4MzE2MX0.T4zgT4OF69BWZ_hKv7ROzLKzwwj-YeIAfvmhJRDFanY"
};
