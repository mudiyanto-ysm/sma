const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// 1. Konfigurasi Koneksi Database MySQL
// Mendukung 2 mode secara otomatis:
//   - LOKAL (XAMPP): jika tidak ada environment variable, jatuh ke default localhost/root/tanpa password
//   - ONLINE (Railway/hosting lain): terisi otomatis dari environment variable MYSQLHOST dkk.
//     yang disuntikkan oleh plugin MySQL Railway, atau DB_HOST dkk. bila pakai penyedia lain.
const db = mysql.createConnection({
    host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
    port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
    user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
    database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'db_persuratan_sekolah'
});

db.connect((err) => {
    if (err) {
        console.error('Gagal terhubung ke database. Pastikan XAMPP/MySQL Anda sudah aktif!');
        throw err;
    }
    console.log('Database MySQL terhubung dengan sukses!');
});

// Bungkus db.query jadi Promise supaya bisa dipakai dengan async/await (lebih rapi untuk endpoint yang banyak query)
function q(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.query(sql, params, (err, results) => err ? reject(err) : resolve(results));
    });
}

// Middleware standard untuk membaca input form (termasuk nested field seperti variabel[key]) dan file statis
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const NAMA_BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

// Helper: konversi angka bulan (1-12) ke format romawi, dipakai untuk nomor surat dinas
function bulanKeRomawi(bulan) {
    const romawi = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
    return romawi[bulan - 1] || 'I';
}

// Helper: ambil daftar nama variabel {seperti_ini} dari isi_template, kecuali field siswa yang sudah otomatis
function ekstrakVariabel(isiTemplate, kategori) {
    const otomatis = kategori === 'siswa' ? ['nama_siswa', 'nisn', 'kelas'] : [];
    const ditemukan = [...isiTemplate.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    return [...new Set(ditemukan)].filter(v => !otomatis.includes(v));
}

// Helper: kalau nilai berformat tanggal (YYYY-MM-DD, dari <input type="date">), ubah ke format Indonesia "27 Agustus 2026"
function formatNilaiVariabel(nilai) {
    if (typeof nilai === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(nilai)) {
        const [y, m, d] = nilai.split('-').map(Number);
        return `${d} ${NAMA_BULAN[m - 1]} ${y}`;
    }
    return nilai;
}

// Helper: ganti semua {key} pada teks dengan nilai dari objek vars (replace-all yang aman, plus auto-format tanggal)
function gantiVariabel(teks, vars) {
    return teks.replace(/\{(\w+)\}/g, (match, key) => {
        const nilai = vars[key];
        if (nilai === undefined || nilai === null || nilai === '') return '[......]';
        return String(formatNilaiVariabel(nilai));
    }).replace(/\n/g, '<br>');
}

// =====================================================
// SISWA — pencarian cepat (dipakai Generator Surat) + CRUD lengkap (dipakai halaman Data Siswa)
// =====================================================

app.get('/api/siswa/search', async (req, res) => {
    const keyword = req.query.q || '';
    if (!keyword) return res.json([]);
    try {
        const results = await q("SELECT id_siswa, nisn, nama_siswa, kelas FROM master_siswa WHERE nama_siswa LIKE ? OR nisn LIKE ? LIMIT 5", [`%${keyword}%`, `%${keyword}%`]);
        res.json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/siswa/list', async (req, res) => {
    try {
        const results = await q("SELECT * FROM master_siswa ORDER BY nama_siswa");
        res.json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/siswa', async (req, res) => {
    const { nisn, nama_siswa, kelas, jurusan, penerima_kjp } = req.body;
    if (!nisn || !nama_siswa || !kelas) return res.status(400).json({ error: 'NISN, Nama, dan Kelas wajib diisi.' });
    try {
        const result = await q("INSERT INTO master_siswa (nisn, nama_siswa, kelas, jurusan, penerima_kjp) VALUES (?, ?, ?, ?, ?)", [nisn, nama_siswa, kelas, jurusan || null, penerima_kjp ? 1 : 0]);
        res.json({ id_siswa: result.insertId, nisn, nama_siswa, kelas });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/siswa/:id', async (req, res) => {
    const { nisn, nama_siswa, kelas, jurusan, penerima_kjp } = req.body;
    if (!nisn || !nama_siswa || !kelas) return res.status(400).json({ error: 'NISN, Nama, dan Kelas wajib diisi.' });
    try {
        await q("UPDATE master_siswa SET nisn=?, nama_siswa=?, kelas=?, jurusan=?, penerima_kjp=? WHERE id_siswa=?", [nisn, nama_siswa, kelas, jurusan || null, penerima_kjp ? 1 : 0, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/siswa/:id', async (req, res) => {
    try {
        await q("DELETE FROM master_siswa WHERE id_siswa=?", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
            return res.status(409).json({ error: 'Siswa ini tidak bisa dihapus karena sudah pernah dibuatkan surat. Riwayat surat harus tetap tersimpan untuk arsip.' });
        }
        res.status(500).json({ error: err.message });
    }
});

// =====================================================
// GURU — CRUD lengkap (dipakai halaman Data Guru), juga dipakai untuk auto-lengkapi Nama Petugas di Surat Tugas
// =====================================================

app.get('/api/guru/list', async (req, res) => {
    try {
        const results = await q("SELECT * FROM guru ORDER BY nama");
        res.json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/guru', async (req, res) => {
    const { nama, nip_nuptk, mapel, status } = req.body;
    if (!nama) return res.status(400).json({ error: 'Nama guru wajib diisi.' });
    try {
        const result = await q("INSERT INTO guru (nama, nip_nuptk, mapel, status) VALUES (?, ?, ?, ?)", [nama, nip_nuptk || null, mapel || null, status || 'GTY']);
        res.json({ id_guru: result.insertId });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/guru/:id', async (req, res) => {
    const { nama, nip_nuptk, mapel, status } = req.body;
    if (!nama) return res.status(400).json({ error: 'Nama guru wajib diisi.' });
    try {
        await q("UPDATE guru SET nama=?, nip_nuptk=?, mapel=?, status=? WHERE id_guru=?", [nama, nip_nuptk || null, mapel || null, status || 'GTY', req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/guru/:id', async (req, res) => {
    try {
        await q("DELETE FROM guru WHERE id_guru=?", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// =====================================================
// PEJABAT — dipakai untuk dropdown Penandatangan & Yang Mengetahui, dikelola lewat halaman Pengaturan
// =====================================================

app.get('/api/pejabat/list', async (req, res) => {
    try {
        const hanyaAktif = req.query.aktif === '1';
        const results = await q(`SELECT * FROM pejabat ${hanyaAktif ? 'WHERE aktif = 1' : ''} ORDER BY nama`);
        res.json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pejabat', async (req, res) => {
    const { nama, jabatan, nip, aktif } = req.body;
    if (!nama || !jabatan) return res.status(400).json({ error: 'Nama dan Jabatan wajib diisi.' });
    try {
        const result = await q("INSERT INTO pejabat (nama, jabatan, nip, aktif) VALUES (?, ?, ?, ?)", [nama, jabatan, nip || null, aktif === false ? 0 : 1]);
        res.json({ id_pejabat: result.insertId });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/pejabat/:id', async (req, res) => {
    const { nama, jabatan, nip, aktif } = req.body;
    if (!nama || !jabatan) return res.status(400).json({ error: 'Nama dan Jabatan wajib diisi.' });
    try {
        await q("UPDATE pejabat SET nama=?, jabatan=?, nip=?, aktif=? WHERE id_pejabat=?", [nama, jabatan, nip || null, aktif === false ? 0 : 1, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/pejabat/:id', async (req, res) => {
    try {
        await q("DELETE FROM pejabat WHERE id_pejabat=?", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// =====================================================
// TEMPLATE SURAT — daftar (dipakai Generator Surat) + CRUD lengkap (dipakai halaman Pengaturan)
// =====================================================

app.get('/api/template/list', async (req, res) => {
    try {
        const results = await q("SELECT * FROM template_dokumen ORDER BY kelompok, id_template");
        const daftar = results.map(t => ({
            id_template: t.id_template,
            kode_perihal: t.kode_perihal,
            nama_surat: t.nama_surat,
            kelompok: t.kelompok,
            kategori: t.kategori,
            format_surat: t.format_surat,
            kepada_yth_default: t.kepada_yth_default,
            isi_template: t.isi_template,
            variabel: ekstrakVariabel(t.isi_template, t.kategori)
        }));
        res.json(daftar);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/template', async (req, res) => {
    const { kode_perihal, nama_surat, kelompok, kategori, format_surat, kepada_yth_default, isi_template } = req.body;
    if (!kode_perihal || !nama_surat || !kelompok || !isi_template) {
        return res.status(400).json({ error: 'Kode Perihal, Nama Surat, Kelompok, dan Isi Template wajib diisi.' });
    }
    try {
        const result = await q(
            "INSERT INTO template_dokumen (kode_perihal, nama_surat, kelompok, kategori, format_surat, kepada_yth_default, isi_template) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [kode_perihal, nama_surat, kelompok, kategori || 'umum', format_surat || 'dinas', kepada_yth_default || null, isi_template]
        );
        res.json({ id_template: result.insertId });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/template/:id', async (req, res) => {
    const { kode_perihal, nama_surat, kelompok, kategori, format_surat, kepada_yth_default, isi_template } = req.body;
    if (!kode_perihal || !nama_surat || !kelompok || !isi_template) {
        return res.status(400).json({ error: 'Kode Perihal, Nama Surat, Kelompok, dan Isi Template wajib diisi.' });
    }
    try {
        await q(
            "UPDATE template_dokumen SET kode_perihal=?, nama_surat=?, kelompok=?, kategori=?, format_surat=?, kepada_yth_default=?, isi_template=? WHERE id_template=?",
            [kode_perihal, nama_surat, kelompok, kategori || 'umum', format_surat || 'dinas', kepada_yth_default || null, isi_template, req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/template/:id', async (req, res) => {
    try {
        await q("DELETE FROM template_dokumen WHERE id_template=?", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
            return res.status(409).json({ error: 'Template ini tidak bisa dihapus karena sudah pernah dipakai menerbitkan surat. Riwayat surat harus tetap tersimpan untuk arsip.' });
        }
        res.status(500).json({ error: err.message });
    }
});

// =====================================================
// DASHBOARD — statistik ringkas + daftar surat terbaru
// =====================================================

app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const [siswa, bulanIni, tahunIni, template] = await Promise.all([
            q("SELECT COUNT(*) AS c FROM master_siswa"),
            q("SELECT COUNT(*) AS c FROM log_surat_keluar WHERE MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())"),
            q("SELECT COUNT(*) AS c FROM log_surat_keluar WHERE YEAR(created_at) = YEAR(CURDATE())"),
            q("SELECT COUNT(*) AS c FROM template_dokumen")
        ]);
        res.json({
            totalSiswa: siswa[0].c,
            suratBulanIni: bulanIni[0].c,
            suratTahunIni: tahunIni[0].c,
            totalTemplate: template[0].c
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/log/recent', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    try {
        const results = await q(`
            SELECT l.id, l.nomor_lengkap, l.created_at, l.penandatangan, t.nama_surat, s.nama_siswa
            FROM log_surat_keluar l
            LEFT JOIN template_dokumen t ON l.id_template = t.id_template
            LEFT JOIN master_siswa s ON l.id_siswa = s.id_siswa
            ORDER BY l.created_at DESC LIMIT ?`, [limit]);
        res.json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Helper: susun 1 lembar surat (badan + tanda tangan + tembusan) — dipakai baik oleh generate satu-per-satu maupun generate massal
function renderLembarSurat({ template, data_siswa, vars, pejabatTtd, pejabatMengetahui, tembusan, lampiran, kepada_yth, nomorLengkap, tanggalCetak }) {
    const isiSurat = gantiVariabel(template.isi_template, vars);

    let badanSurat = '';
    if (template.format_surat === 'keterangan') {
        badanSurat = `
            <p>Yang bertanda tangan di bawah ini, Kepala Sekolah Menengah Atas (SMA) Swasta Jakarta Timur menerangkan dengan sesungguhnya bahwa:</p>
            ${data_siswa ? `
            <table style="margin-left: 40px; margin-bottom: 20px;">
                <tr><td style="width: 150px;">Nama Lengkap</td><td>: <strong>${data_siswa.nama_siswa}</strong></td></tr>
                <tr><td>NISN</td><td>: ${data_siswa.nisn}</td></tr>
                <tr><td>Fase / Kelas</td><td>: ${data_siswa.kelas}</td></tr>
            </table>` : ''}
            <p class="isi-surat">${isiSurat}</p>
            <p>Demikian surat keterangan ini dibuat dengan sebenarnya agar dapat dipergunakan sebagaimana mestinya.</p>`;
    } else if (template.format_surat === 'tugas') {
        badanSurat = `
            <p style="text-indent:0;">Yang bertanda tangan di bawah ini, Kepala Sekolah Menengah Atas (SMA) Swasta Jakarta Timur, dengan ini menugaskan:</p>
            <p class="isi-surat" style="text-indent:0;">${isiSurat}</p>
            <p>Demikian surat tugas ini dibuat untuk dilaksanakan dengan penuh tanggung jawab. Kepada yang bersangkutan diharapkan melapor kembali setelah tugas selesai dilaksanakan.</p>`;
    } else {
        const tujuan = kepada_yth || template.kepada_yth_default || '.....................';
        badanSurat = `
            <p style="margin-bottom: 20px;">Kepada Yth.<br><strong>${tujuan}</strong><br>di tempat</p>
            <p style="text-indent:0;">Dengan hormat,</p>
            <p class="isi-surat">${isiSurat}</p>
            <p>Demikian surat ini kami sampaikan, atas perhatian dan kerja sama yang diberikan kami ucapkan terima kasih.</p>`;
    }

    let blokTandaTangan;
    if (pejabatMengetahui) {
        blokTandaTangan = `
            <div style="display:flex; justify-content:space-between; margin-top:20px;">
                <div style="text-align:left; width:250px;">
                    <p>Mengetahui,</p>
                    <p>${pejabatMengetahui.jabatan},</p>
                    <br><br><br><br>
                    <p style="font-weight: bold; text-decoration: underline;">${pejabatMengetahui.nama}</p>
                    <p>${pejabatMengetahui.nip ? 'NIP. ' + pejabatMengetahui.nip : ''}</p>
                </div>
                <div style="text-align:left; width:250px;">
                    <p>Jakarta, ${tanggalCetak}</p>
                    <p>${pejabatTtd.jabatan},</p>
                    <br><br><br><br>
                    <p style="font-weight: bold; text-decoration: underline;">${pejabatTtd.nama}</p>
                    <p>${pejabatTtd.nip ? 'NIP. ' + pejabatTtd.nip : ''}</p>
                </div>
            </div>`;
    } else {
        blokTandaTangan = `
            <div class="tanda-tangan">
                <p>Jakarta, ${tanggalCetak}</p>
                <p>${pejabatTtd.jabatan},</p>
                <br><br><br><br>
                <p style="font-weight: bold; text-decoration: underline;">${pejabatTtd.nama}</p>
                <p>${pejabatTtd.nip ? 'NIP. ' + pejabatTtd.nip : ''}</p>
            </div>`;
    }

    let blokTembusan = '';
    if (tembusan && tembusan.trim()) {
        const daftarTembusan = tembusan.split('\n').map(t => t.trim()).filter(Boolean);
        blokTembusan = `
            <div style="clear:both; margin-top:40px; font-size:10pt;">
                <p style="margin-bottom:4px;">Tembusan:</p>
                <ol style="margin:0; padding-left:20px;">
                    ${daftarTembusan.map(t => `<li>${t}</li>`).join('')}
                </ol>
            </div>`;
    }

    const barisLampiran = lampiran && lampiran.trim() ? `<p class="nomor-surat" style="margin-top:-20px;">Lampiran: ${lampiran}</p>` : '';

    return `
        <div class="lembar-surat">
            <div class="kop-surat">
                <h1>SMA SWASTA JAKARTA TIMUR</h1>
                <p>Jl. Raya Pendidikan No. 12, Suku Dinas Pendidikan Wilayah II, Kota Jakarta Timur, DKI Jakarta</p>
            </div>
            <p class="judul-surat">${template.nama_surat.toUpperCase()}</p>
            <p class="nomor-surat">Nomor: ${nomorLengkap}</p>
            ${barisLampiran}
            <div class="area-edit" contenteditable="true">
                ${badanSurat}
            </div>
            ${blokTandaTangan}
            ${blokTembusan}
        </div>`;
}

const CSS_HALAMAN_SURAT = `
    body { font-family: "Times New Roman", Times, serif; padding: 40px; line-height: 1.6; font-size: 12pt; }
    .kop-surat { text-align: center; border-bottom: 3px double #000; padding-bottom: 10px; margin-bottom: 25px; }
    .kop-surat h1 { margin: 0; font-size: 16pt; font-weight: bold; }
    .kop-surat p { margin: 2px 0; font-size: 10pt; font-style: italic; }
    .judul-surat { text-align: center; font-weight: bold; text-decoration: underline; margin-bottom: 5px; font-size: 14pt; }
    .nomor-surat { text-align: center; margin-top: 0; margin-bottom: 10px; font-family: monospace; }
    .isi-surat { text-align: justify; text-indent: 40px; margin-bottom: 20px; }
    .tanda-tangan { float: right; text-align: left; width: 250px; margin-top: 20px; }
    .hint-edit { background:#eff6ff; border:1px solid #bfdbfe; color:#1e3a8a; font-size:10pt; font-family: Arial, sans-serif; padding:10px 14px; border-radius:6px; margin-bottom:20px; }
    .area-edit { outline: 1px dashed transparent; padding: 6px; border-radius: 4px; transition: outline-color .15s, background .15s; }
    .area-edit:hover, .area-edit:focus { outline-color: #93c5fd; background: #f8fafc; outline-style: dashed; }
    .tombol-aksi { position: fixed; bottom: 20px; right: 20px; background: #2563eb; color: white; padding: 12px 24px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    .lembar-surat:not(:last-of-type) { page-break-after: always; }
    @media print { .tombol-aksi, .hint-edit { display: none; } .area-edit { outline: none !important; background: transparent !important; } }
`;

// =====================================================
// GENERATOR SURAT — inti aplikasi
// =====================================================

app.post('/api/surat/generate', async (req, res) => {
    const { id_template, id_siswa, kepada_yth, penandatangan_id, mengetahui_id, tembusan, lampiran } = req.body;
    const variabelManual = req.body.variabel || {};

    if (!id_template) return res.status(400).send('Harap pilih jenis surat terlebih dahulu.');
    if (!penandatangan_id) return res.status(400).send('Harap pilih pejabat penandatangan.');

    try {
        const tplResults = await q("SELECT * FROM template_dokumen WHERE id_template = ?", [id_template]);
        if (tplResults.length === 0) return res.status(404).send('Template surat tidak ditemukan.');
        const template = tplResults[0];

        let data_siswa = null;
        if (template.kategori === 'siswa') {
            if (!id_siswa) return res.status(400).send('Harap pilih siswa terlebih dahulu dari database.');
            const siswaResults = await q("SELECT * FROM master_siswa WHERE id_siswa = ?", [id_siswa]);
            if (siswaResults.length === 0) return res.status(404).send('Data siswa tidak ditemukan.');
            data_siswa = siswaResults[0];
        }

        const penandatanganResults = await q("SELECT * FROM pejabat WHERE id_pejabat = ?", [penandatangan_id]);
        if (penandatanganResults.length === 0) return res.status(404).send('Pejabat penandatangan tidak ditemukan.');
        const pejabatTtd = penandatanganResults[0];

        let pejabatMengetahui = null;
        if (mengetahui_id) {
            const mResults = await q("SELECT * FROM pejabat WHERE id_pejabat = ?", [mengetahui_id]);
            if (mResults.length > 0) pejabatMengetahui = mResults[0];
        }

        // Hitung nomor urut surat keluar secara berurutan (satu nomor urut global untuk semua jenis surat)
        const row = await q("SELECT IFNULL(MAX(nomor_urut), 0) + 1 AS nomor_baru FROM log_surat_keluar");
        const nomorUrut = row[0].nomor_baru;
        const sekarang = new Date();
        const bulanRomawi = bulanKeRomawi(sekarang.getMonth() + 1);
        const tahunSekarang = sekarang.getFullYear();
        const nomorLengkap = `${nomorUrut}/${template.kode_perihal}/SMA-SW/${bulanRomawi}/${tahunSekarang}`;
        const tanggalCetak = `${sekarang.getDate()} ${NAMA_BULAN[sekarang.getMonth()]} ${sekarang.getFullYear()}`;

        // ENGINE AUTO-MERGE: gabungkan data siswa (jika ada) dengan variabel manual dari form
        const vars = { ...variabelManual };
        if (data_siswa) {
            vars.nama_siswa = data_siswa.nama_siswa;
            vars.nisn = data_siswa.nisn;
            vars.kelas = data_siswa.kelas;
        }

        const lembarSurat = renderLembarSurat({ template, data_siswa, vars, pejabatTtd, pejabatMengetahui, tembusan, lampiran, kepada_yth, nomorLengkap, tanggalCetak });

        // Simpan riwayat cetak surat ini ke dalam tabel Log Surat Keluar (Buku Agenda TU)
        const penandatanganText = `${pejabatTtd.nama} (${pejabatTtd.jabatan})`;
        await q(
            "INSERT INTO log_surat_keluar (nomor_urut, nomor_lengkap, id_template, id_siswa, tujuan_surat, penandatangan, mengetahui, tembusan, lampiran, operator_tu) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Staf TU')",
            [nomorUrut, nomorLengkap, id_template, id_siswa || null, kepada_yth || variabelManual.tujuan_surat || null, penandatanganText, pejabatMengetahui ? `${pejabatMengetahui.nama} (${pejabatMengetahui.jabatan})` : null, tembusan || null, lampiran || null]
        );

        res.send(`
            <!DOCTYPE html>
            <html lang="id">
            <head>
                <title>Cetak - ${nomorLengkap.replace(/\//g, '_')}</title>
                <style>${CSS_HALAMAN_SURAT}</style>
            </head>
            <body>
                <div class="hint-edit">💡 Ada kalimat yang perlu disesuaikan? Klik langsung pada teks surat di bawah ini untuk mengedit sebelum mencetak. Perubahan hanya berlaku di lembar ini, tidak mengubah template aslinya.</div>
                ${lembarSurat}
                <button class="tombol-aksi" onclick="window.print()">🖨️ Cetak Surat ke Printer / Simpan PDF</button>
            </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('Terjadi kesalahan: ' + err.message);
    }
});

// API Endpoint untuk Generate Surat MASSAL — satu jenis surat (kategori 'siswa') untuk banyak siswa sekaligus,
// digabung jadi satu halaman siap cetak dengan page-break otomatis per siswa.
app.post('/api/surat/generate-massal', async (req, res) => {
    const { id_template, kepada_yth, penandatangan_id, mengetahui_id, tembusan, lampiran } = req.body;
    const variabelManual = req.body.variabel || {};
    let daftarIdSiswa = req.body.id_siswa_list || [];
    if (!Array.isArray(daftarIdSiswa)) daftarIdSiswa = [daftarIdSiswa];

    if (!id_template) return res.status(400).send('Harap pilih jenis surat terlebih dahulu.');
    if (!penandatangan_id) return res.status(400).send('Harap pilih pejabat penandatangan.');
    if (daftarIdSiswa.length === 0) return res.status(400).send('Harap pilih minimal satu siswa.');

    try {
        const tplResults = await q("SELECT * FROM template_dokumen WHERE id_template = ?", [id_template]);
        if (tplResults.length === 0) return res.status(404).send('Template surat tidak ditemukan.');
        const template = tplResults[0];
        if (template.kategori !== 'siswa') return res.status(400).send('Surat massal hanya berlaku untuk jenis surat berbasis data siswa.');

        const penandatanganResults = await q("SELECT * FROM pejabat WHERE id_pejabat = ?", [penandatangan_id]);
        if (penandatanganResults.length === 0) return res.status(404).send('Pejabat penandatangan tidak ditemukan.');
        const pejabatTtd = penandatanganResults[0];

        let pejabatMengetahui = null;
        if (mengetahui_id) {
            const mResults = await q("SELECT * FROM pejabat WHERE id_pejabat = ?", [mengetahui_id]);
            if (mResults.length > 0) pejabatMengetahui = mResults[0];
        }

        const sekarang = new Date();
        const bulanRomawi = bulanKeRomawi(sekarang.getMonth() + 1);
        const tahunSekarang = sekarang.getFullYear();
        const tanggalCetak = `${sekarang.getDate()} ${NAMA_BULAN[sekarang.getMonth()]} ${sekarang.getFullYear()}`;

        // Nomor urut awal, akan bertambah 1 untuk setiap siswa dalam batch ini
        const row = await q("SELECT IFNULL(MAX(nomor_urut), 0) FROM log_surat_keluar");
        let nomorUrutBerjalan = Object.values(row[0])[0];

        const semuaLembar = [];
        const gagal = [];

        for (const idSiswa of daftarIdSiswa) {
            const siswaResults = await q("SELECT * FROM master_siswa WHERE id_siswa = ?", [idSiswa]);
            if (siswaResults.length === 0) { gagal.push(idSiswa); continue; }
            const data_siswa = siswaResults[0];

            nomorUrutBerjalan += 1;
            const nomorLengkap = `${nomorUrutBerjalan}/${template.kode_perihal}/SMA-SW/${bulanRomawi}/${tahunSekarang}`;

            const vars = { ...variabelManual, nama_siswa: data_siswa.nama_siswa, nisn: data_siswa.nisn, kelas: data_siswa.kelas };
            const lembar = renderLembarSurat({ template, data_siswa, vars, pejabatTtd, pejabatMengetahui, tembusan, lampiran, kepada_yth, nomorLengkap, tanggalCetak });
            semuaLembar.push(lembar);

            const penandatanganText = `${pejabatTtd.nama} (${pejabatTtd.jabatan})`;
            await q(
                "INSERT INTO log_surat_keluar (nomor_urut, nomor_lengkap, id_template, id_siswa, tujuan_surat, penandatangan, mengetahui, tembusan, lampiran, operator_tu) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Staf TU')",
                [nomorUrutBerjalan, nomorLengkap, id_template, idSiswa, kepada_yth || variabelManual.tujuan_surat || null, penandatanganText, pejabatMengetahui ? `${pejabatMengetahui.nama} (${pejabatMengetahui.jabatan})` : null, tembusan || null, lampiran || null]
            );
        }

        if (semuaLembar.length === 0) return res.status(404).send('Tidak ada data siswa yang valid ditemukan.');

        res.send(`
            <!DOCTYPE html>
            <html lang="id">
            <head>
                <title>Cetak Massal - ${template.nama_surat}</title>
                <style>${CSS_HALAMAN_SURAT}</style>
            </head>
            <body>
                <div class="hint-edit">💡 Surat massal untuk ${semuaLembar.length} siswa${gagal.length ? ` (${gagal.length} data siswa tidak ditemukan dan dilewati)` : ''}. Setiap lembar otomatis pindah halaman saat dicetak. Klik teks pada lembar mana pun untuk mengedit sebelum mencetak.</div>
                ${semuaLembar.join('')}
                <button class="tombol-aksi" onclick="window.print()">🖨️ Cetak Semua (${semuaLembar.length} Surat) / Simpan PDF</button>
            </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('Terjadi kesalahan: ' + err.message);
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Aplikasi berjalan lancar di port ${PORT}! (Lokal: http://localhost:${PORT})`));
