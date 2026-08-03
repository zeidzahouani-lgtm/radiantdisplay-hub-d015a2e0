import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { getSupabasePublishableKey, getSupabaseUrl } from '@/lib/env';

const SUPABASE_URL = getSupabaseUrl();
const SUPABASE_PUBLISHABLE_KEY = getSupabasePublishableKey();

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    storageKey: 'screenflow-local-auth-v3',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});