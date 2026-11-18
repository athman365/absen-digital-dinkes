import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' }
});
const encoder = new TextEncoder();
const toBase64Url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const fromBase64Url = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(normalized), c => c.charCodeAt(0));
};
async function sign(payload, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}
async function makeToken(secret) {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ exp: Date.now() + 8 * 60 * 60 * 1000 })));
  return payload + '.' + await sign(payload, secret);
}
async function authorized(request, secret) {
  try {
    const [payload, signature] = (request.headers.get('x-admin-token') || '').split('.');
    if (!payload || !signature || !(await sign(payload, secret)).includes(signature)) return false;
    const expected = await sign(payload, secret);
    if (expected !== signature) return false;
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    return data.exp > Date.now();
  } catch { return false; }
}
const csvValue = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.ADMIN_PASSWORD || !env.TOKEN_SECRET) {
      return json({ error: 'Konfigurasi Worker belum lengkap. Periksa Environment Variables.' }, 500);
    }
    let diagnosticStage = 'inisialisasi Supabase client';
    try {
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      const requireAuth = async () => await authorized(request, env.TOKEN_SECRET);
      if (url.pathname === '/api/login' && request.method === 'POST') {
        const body = await request.json();
        if (body.password !== env.ADMIN_PASSWORD) return json({ error: 'Password salah' }, 401);
        return json({ token: await makeToken(env.TOKEN_SECRET) });
      }
      if (url.pathname === '/api/summary' && request.method === 'GET') {
        diagnosticStage = 'membaca tabel pegawai';
        const p = await supabase.from('pegawai').select('id', { count: 'exact', head: true });
        if (p.error) throw p.error;
        diagnosticStage = 'membaca tabel apel';
        const a = await supabase.from('apel').select('id,nama_apel,tanggal,jam_mulai').order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (a.error) throw a.error;
        let hadir = 0;
        if (a.data) {
          diagnosticStage = 'membaca tabel kehadiran';
          const k = await supabase.from('kehadiran').select('id', { count: 'exact', head: true }).eq('apel_id', a.data.id);
          if (k.error) throw k.error;
          hadir = k.count || 0;
        }
        return json({ event: a.data ? { id: a.data.id, title: a.data.nama_apel, event_date: a.data.tanggal, start_time: a.data.jam_mulai } : null, total: p.count || 0, hadir, belum: Math.max(0, (p.count || 0) - hadir) });
      }
      if (!(await requireAuth())) return json({ error: 'Sesi petugas tidak valid atau sudah berakhir. Silakan login kembali.' }, 401);

      if (url.pathname === '/api/events' && request.method === 'GET') {
        const { data, error } = await supabase.from('apel').select('id,nama_apel,tanggal,jam_mulai,status').order('created_at', { ascending: false });
        if (error) throw error;
        return json((data || []).map(x => ({ id:x.id, title:x.nama_apel, event_date:x.tanggal, start_time:x.jam_mulai, status:x.status })));
      }
      if (url.pathname === '/api/events' && request.method === 'POST') {
        const body = await request.json();
        const { title, event_date, start_time } = body;
        if (!title || !event_date || !start_time) return json({ error: 'Nama, tanggal, dan waktu apel wajib diisi' }, 400);
        const { data, error } = await supabase.from('apel').insert({ nama_apel:title, tanggal:event_date, jam_mulai:start_time, status:'aktif' }).select('id,nama_apel,tanggal,jam_mulai,status').single();
        if (error) throw error;
        return json({ id:data.id, title:data.nama_apel, event_date:data.tanggal, start_time:data.jam_mulai, status:data.status });
      }
      if (url.pathname === '/api/employees/import' && request.method === 'POST') {
        const form = await request.formData();
        const file = form.get('file');
        if (!file || typeof file.text !== 'function') return json({ error: 'Pilih file CSV terlebih dahulu' }, 400);
        if (file.size > 5 * 1024 * 1024) return json({ error: 'Ukuran file maksimal 5 MB' }, 400);
        const rows = parse((await file.text()).replace(/^\uFEFF/, ''), { columns:true, skip_empty_lines:true, trim:true });
        const records = [];
        for (const row of rows) {
          const get = (...keys) => { for (const k of keys) if (row[k] != null && String(row[k]).trim()) return String(row[k]).trim(); return ''; };
          const nip = get('NIP','nip'), nama = get('Nama','nama','name');
          if (!nip || !nama) continue;
          records.push({ nip, nama, jenis_kelamin:get('Jenis Kelamin','jenis_kelamin'), unit_kerja:get('Unit Kerja','unit_kerja'), qr_code:get('QR','qr','QR Code','qr_code') || nip });
        }
        if (!records.length) return json({ error:'CSV tidak memiliki baris valid dengan NIP dan Nama.' }, 400);
        const { error } = await supabase.from('pegawai').upsert(records, { onConflict:'nip' });
        if (error) throw error;
        return json({ imported:records.length });
      }
      if (url.pathname === '/api/scan' && request.method === 'POST') {
        const { event_id, qr_value } = await request.json();
        if (!event_id || !qr_value) return json({ error:'QR atau kegiatan belum dipilih' }, 400);
        const code = String(qr_value).trim();
        let result = await supabase.from('pegawai').select('id,nip,nama,unit_kerja').eq('nip',code).maybeSingle();
        if (result.error) throw result.error;
        if (!result.data) result = await supabase.from('pegawai').select('id,nip,nama,unit_kerja').eq('qr_code',code).maybeSingle();
        if (result.error) throw result.error;
        const emp = result.data;
        if (!emp) return json({ error:'QR tidak terdaftar dalam database pegawai' }, 404);
        const { error } = await supabase.from('kehadiran').insert({ apel_id:event_id, pegawai_id:emp.id, status:'hadir' });
        if (error?.code === '23505') return json({ error:'Pegawai ini sudah tercatat hadir pada apel ini', employee:{ name:emp.nama, nip:emp.nip, unit:emp.unit_kerja } }, 409);
        if (error) throw error;
        return json({ ok:true, employee:{ name:emp.nama, nip:emp.nip, unit:emp.unit_kerja } });
      }
      const attendanceMatch = url.pathname.match(/^\/api\/attendance\/(\d+)$/);
      if (attendanceMatch && request.method === 'GET') {
        const { data, error } = await supabase.from('kehadiran').select('pegawai_id,waktu_scan').eq('apel_id',attendanceMatch[1]).order('waktu_scan',{ascending:false});
        if (error) throw error;
        const ids = [...new Set((data || []).map(r => r.pegawai_id))];
        const employees = ids.length ? await supabase.from('pegawai').select('id,nip,nama,unit_kerja').in('id', ids) : { data:[], error:null };
        if (employees.error) throw employees.error;
        const byId = new Map((employees.data || []).map(e => [e.id,e]));
        return json((data || []).map(r => { const e = byId.get(r.pegawai_id) || {}; return { nip:e.nip || '', name:e.nama || '', unit:e.unit_kerja || '', scanned_at:r.waktu_scan }; }));
      }
      const exportMatch = url.pathname.match(/^\/api\/export\/(\d+)$/);
      if (exportMatch && request.method === 'GET') {
        const { data, error } = await supabase.from('kehadiran').select('pegawai_id,waktu_scan,status').eq('apel_id',exportMatch[1]).order('waktu_scan',{ascending:true});
        if (error) throw error;
        const ids = [...new Set((data || []).map(r => r.pegawai_id))];
        const employees = ids.length ? await supabase.from('pegawai').select('id,nip,nama,jenis_kelamin,unit_kerja').in('id', ids) : { data:[], error:null };
        if (employees.error) throw employees.error;
        const byId = new Map((employees.data || []).map(e => [e.id,e]));
        const lines = ['NIP,Nama,Jenis Kelamin,Unit Kerja,Waktu Scan,Status', ...(data || []).map(r => { const e = byId.get(r.pegawai_id) || {}; return [e.nip,e.nama,e.jenis_kelamin,e.unit_kerja,r.waktu_scan,r.status].map(csvValue).join(','); })];
        return new Response('\uFEFF' + lines.join('\n'), { headers: { 'content-type':'text/csv; charset=utf-8', 'content-disposition':'attachment; filename="rekap-absen.csv"' } });
      }
      return json({ error:'Endpoint tidak ditemukan' }, 404);
    } catch (error) {
      console.error('API error detail', {
        stage: diagnosticStage,
        message: error?.message ?? null,
        messageType: typeof error?.message,
        serializedError: (() => { try { return JSON.stringify(error); } catch { return null; } })(),
        errorString: String(error),
        errorType: typeof error,
        errorName: error?.name || null,
        code: error?.code || null,
        details: error?.details || null,
        hint: error?.hint || null,
        keys: error && typeof error === 'object' ? Object.keys(error) : []
      });
      return json({
        error: 'Diagnostik Supabase',
        stage: diagnosticStage,
        message: error?.message ?? null,
        messageType: typeof error?.message,
        serializedError: (() => { try { return JSON.stringify(error); } catch { return null; } })(),
        errorType: typeof error,
        errorName: error?.name || null,
        errorString: String(error),
        code: error?.code || null,
        details: error?.details || null,
        hint: error?.hint || null,
        keys: error && typeof error === 'object' ? Object.keys(error) : []
      }, 500);
    }
  }
};
