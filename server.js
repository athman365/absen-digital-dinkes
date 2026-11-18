const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const path = require('path');
const crypto = require('crypto');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TOKEN_SECRET = process.env.TOKEN_SECRET;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ADMIN_PASSWORD || !TOKEN_SECRET) throw new Error('Lengkapi SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_PASSWORD, TOKEN_SECRET.');
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
}
function auth(req, res, next) {
  try {
    const [payload, signature] = String(req.headers['x-admin-token'] || '').split('.');
    if (!payload || !signature) throw new Error('Akses petugas diperlukan');
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest();
    const received = Buffer.from(signature, 'base64url');
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) throw new Error('Token tidak valid');
    if (JSON.parse(Buffer.from(payload, 'base64url').toString()).exp < Date.now()) throw new Error('Sesi berakhir, silakan login kembali');
    next();
  } catch (e) { res.status(401).json({ error: e.message }); }
}
function fail(res, e) { console.error(e); res.status(500).json({ error: 'Gagal mengakses database Supabase. Periksa konfigurasi dan struktur tabel.' }); }
const csvValue = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';

app.post('/api/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Password salah' });
  res.json({ token: makeToken() });
});
app.get('/api/summary', async (req, res) => {
  try {
    const [p, a] = await Promise.all([
      supabase.from('pegawai').select('id', { count: 'exact', head: true }),
      supabase.from('apel').select('id,nama_apel,tanggal,jam_mulai').order('created_at', { ascending: false }).limit(1).maybeSingle()
    ]);
    if (p.error) throw p.error; if (a.error) throw a.error;
    let hadir = 0;
    if (a.data) { const k = await supabase.from('kehadiran').select('id', { count: 'exact', head: true }).eq('apel_id', a.data.id); if (k.error) throw k.error; hadir = k.count || 0; }
    res.json({ event: a.data ? { id: a.data.id, title: a.data.nama_apel, event_date: a.data.tanggal, start_time: a.data.jam_mulai } : null, total: p.count || 0, hadir, belum: Math.max(0, (p.count || 0) - hadir) });
  } catch (e) { fail(res, e); }
});
app.get('/api/events', auth, async (req, res) => {
  try { const { data, error } = await supabase.from('apel').select('id,nama_apel,tanggal,jam_mulai,status').order('created_at', { ascending: false }); if (error) throw error; res.json(data.map(x => ({ id:x.id, title:x.nama_apel, event_date:x.tanggal, start_time:x.jam_mulai, status:x.status }))); } catch(e) { fail(res,e); }
});
app.post('/api/events', auth, async (req, res) => {
  const { title, event_date, start_time } = req.body;
  if (!title || !event_date || !start_time) return res.status(400).json({ error: 'Nama, tanggal, dan waktu apel wajib diisi' });
  try { const { data, error } = await supabase.from('apel').insert({ nama_apel:title, tanggal:event_date, jam_mulai:start_time, status:'aktif' }).select('id,nama_apel,tanggal,jam_mulai,status').single(); if(error) throw error; res.json({ id:data.id, title:data.nama_apel, event_date:data.tanggal, start_time:data.jam_mulai, status:data.status }); } catch(e) { fail(res,e); }
});
app.post('/api/employees/import', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Pilih file CSV terlebih dahulu' });
  try {
    const rows = parse(req.file.buffer.toString('utf8').replace(/^\uFEFF/, ''), { columns:true, skip_empty_lines:true, trim:true });
    const records = [];
    for (const row of rows) {
      const get = (...keys) => { for (const k of keys) if (row[k] != null && String(row[k]).trim()) return String(row[k]).trim(); return ''; };
      const nip = get('NIP','nip'), nama = get('Nama','nama','name');
      if (!nip || !nama) continue;
      records.push({ nip, nama, jenis_kelamin:get('Jenis Kelamin','jenis_kelamin'), unit_kerja:get('Unit Kerja','unit_kerja'), qr_code:get('QR','qr','QR Code','qr_code') || nip });
    }
    if (!records.length) return res.status(400).json({ error:'CSV tidak memiliki baris valid dengan NIP dan Nama.' });
    const { error } = await supabase.from('pegawai').upsert(records, { onConflict:'nip' }); if(error) throw error;
    res.json({ imported:records.length });
  } catch(e) { fail(res,e); }
});
app.post('/api/scan', auth, async (req, res) => {
  const { event_id, qr_value } = req.body;
  if (!event_id || !qr_value) return res.status(400).json({ error:'QR atau kegiatan belum dipilih' });
  try {
    const code = String(qr_value).trim();
    let result = await supabase.from('pegawai').select('id,nip,nama,unit_kerja').eq('nip',code).maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) result = await supabase.from('pegawai').select('id,nip,nama,unit_kerja').eq('qr_code',code).maybeSingle();
    if (result.error) throw result.error;
    const emp = result.data;
    if (!emp) return res.status(404).json({ error:'QR tidak terdaftar dalam database pegawai' });
    const { error } = await supabase.from('kehadiran').insert({ apel_id:event_id, pegawai_id:emp.id, status:'hadir' });
    if (error?.code === '23505') return res.status(409).json({ error:'Pegawai ini sudah tercatat hadir pada apel ini', employee:{ name:emp.nama, nip:emp.nip, unit:emp.unit_kerja } });
    if (error) throw error;
    res.json({ ok:true, employee:{ name:emp.nama, nip:emp.nip, unit:emp.unit_kerja } });
  } catch(e) { fail(res,e); }
});
app.get('/api/attendance/:eventId', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('kehadiran').select('waktu_scan,pegawai:pegawai_id(nip,nama,jabatan,unit_kerja)').eq('apel_id',req.params.eventId).order('waktu_scan',{ascending:false});
    if(error) throw error;
    res.json(data.map(r => ({ nip:r.pegawai?.nip || '', name:r.pegawai?.nama || '', position:r.pegawai?.jabatan || '', unit:r.pegawai?.unit_kerja || '', scanned_at:r.waktu_scan })));
  } catch(e) { fail(res,e); }
});
app.get('/api/export/:eventId', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('kehadiran').select('waktu_scan,status,pegawai:pegawai_id(nip,nama,jenis_kelamin,unit_kerja)').eq('apel_id',req.params.eventId).order('waktu_scan',{ascending:true});
    if(error) throw error;
    const lines = ['NIP,Nama,Jenis Kelamin,Unit Kerja,Waktu Scan,Status', ...data.map(r => [r.pegawai?.nip,r.pegawai?.nama,r.pegawai?.jenis_kelamin,r.pegawai?.unit_kerja,r.waktu_scan,r.status].map(csvValue).join(','))];
    res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename="rekap-absen.csv"'); res.send('\uFEFF' + lines.join('\n'));
  } catch(e) { fail(res,e); }
});
const port = process.env.PORT || 3000;
app.listen(port,'0.0.0.0',() => console.log('Absen Digital Dinkes berjalan di port ' + port));
