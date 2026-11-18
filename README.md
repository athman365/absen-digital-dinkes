# Absen Digital Dinkes Tangsel

Starter web app untuk presensi apel dengan QR ID Card, database pegawai SQLite, cegah scan ganda, rekap dan ekspor CSV.

## Jalankan di Replit
1. Buat Repl baru tipe **Node.js**.
2. Upload seluruh isi folder/ZIP proyek ini.
3. Di **Secrets**, isi `ADMIN_PASSWORD` dengan password admin yang kuat (jangan gunakan password contoh).
4. Klik Run. Aplikasi berjalan pada port 3000.
5. Buka menu Admin, login, lalu impor master pegawai dalam format CSV UTF-8.
6. Buat kegiatan apel. Scan QR dilakukan melalui kamera HP; izinkan akses kamera.

## Format impor
Header CSV yang didukung: `NIP,Nama,Jenis Kelamin,Status Pegawai,Golongan,Jabatan,TMT Jabatan,Unit Kerja,QR`.
Jika QR ID Card berisi NIP, kolom QR boleh dikosongkan. Jika QR berisi tautan/teks lain, isi kolom QR dengan nilai QR persis dan NIP tetap diisi.

## Catatan
- Database tersimpan di `attendance.db` pada server.
- Pastikan Replit deployment menggunakan persistent storage/volume untuk file database agar data tidak hilang saat instance diganti.
- Gunakan HTTPS (Replit deployment menyediakan HTTPS) agar kamera HP dapat diakses.
- Ini starter operasional; sebelum dipakai resmi, lakukan uji coba QR dari seluruh tipe ID card, backup database, dan tetapkan pengelolaan akun petugas.
- Login admin melindungi fungsi pengelolaan dan rekap. Presensi scan juga memerlukan sesi admin pada perangkat petugas.
