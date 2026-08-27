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

// Middleware standard untuk membaca input form (termasuk nested field seperti variabel[key]) dan file statis
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

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

// Helper: ganti semua {key} pada teks dengan nilai dari objek vars (replace-all yang aman)
function gantiVariabel(teks, vars) {
    return teks.replace(/\{(\w+)\}/g, (match, key) => {
        const nilai = vars[key];
        return (nilai === undefined || nilai === null || nilai === '') ? '[......]' : String(nilai);
    }).replace(/\n/g, '<br>');
}

// 2. API Endpoint untuk Fitur Pencarian Cepat Data Siswa (Live Search)
app.get('/api/siswa/search', (req, res) => {
    const keyword = req.query.q || '';
    if (!keyword) return res.json([]);

    const query = "SELECT id_siswa, nisn, nama_siswa, kelas FROM master_siswa WHERE nama_siswa LIKE ? OR nisn LIKE ? LIMIT 5";
    db.query(query, [`%${keyword}%`, `%${keyword}%`], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 3. API Endpoint untuk Mengambil Daftar Template Surat (dikelompokkan per kategori surat)
app.get('/api/template/list', (req, res) => {
    const query = "SELECT id_template, kode_perihal, nama_surat, kelompok, kategori, format_surat, kepada_yth_default, isi_template FROM template_dokumen ORDER BY kelompok, id_template";
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });

        const daftar = results.map(t => ({
            id_template: t.id_template,
            kode_perihal: t.kode_perihal,
            nama_surat: t.nama_surat,
            kelompok: t.kelompok,
            kategori: t.kategori,
            format_surat: t.format_surat,
            kepada_yth_default: t.kepada_yth_default,
            variabel: ekstrakVariabel(t.isi_template, t.kategori)
        }));
        res.json(daftar);
    });
});

// 4. API Endpoint untuk Memproses Pembuatan Surat & Cetak PDF Otomatis (mendukung semua jenis template)
app.post('/api/surat/generate', (req, res) => {
    const { id_template, id_siswa, kepada_yth, penandatangan } = req.body;
    const variabelManual = req.body.variabel || {};

    if (!id_template) return res.status(400).send('Harap pilih jenis surat terlebih dahulu.');
    if (!penandatangan) return res.status(400).send('Harap pilih pejabat penandatangan.');

    db.query("SELECT * FROM template_dokumen WHERE id_template = ?", [id_template], (err, tplResults) => {
        if (err || tplResults.length === 0) return res.status(404).send('Template surat tidak ditemukan.');
        const template = tplResults[0];

        // Jika template berkategori 'siswa', wajib pilih siswa dan tarik data resminya dari database
        if (template.kategori === 'siswa') {
            if (!id_siswa) return res.status(400).send('Harap pilih siswa terlebih dahulu dari database.');

            db.query("SELECT * FROM master_siswa WHERE id_siswa = ?", [id_siswa], (err, siswaResults) => {
                if (err || siswaResults.length === 0) return res.status(404).send('Data siswa tidak ditemukan.');
                prosesGenerate(template, siswaResults[0]);
            });
        } else {
            prosesGenerate(template, null);
        }

        function prosesGenerate(data_template, data_siswa) {
            // Hitung nomor urut surat keluar secara berurutan berdasarkan rekam jejak log arsip (satu nomor urut global untuk semua jenis surat)
            db.query("SELECT IFNULL(MAX(nomor_urut), 0) + 1 AS nomor_baru FROM log_surat_keluar", (err, row) => {
                if (err) return res.status(500).send(err.message);

                const nomorUrut = row[0].nomor_baru;
                const sekarang = new Date();
                const bulanRomawi = bulanKeRomawi(sekarang.getMonth() + 1); // Bulan berjalan otomatis mengikuti tanggal server
                const tahunSekarang = sekarang.getFullYear();
                const nomorLengkap = `${nomorUrut}/${data_template.kode_perihal}/SMA-SW/${bulanRomawi}/${tahunSekarang}`;

                // ENGINE AUTO-MERGE: gabungkan data siswa (jika ada) dengan variabel manual dari form
                const vars = { ...variabelManual };
                if (data_siswa) {
                    vars.nama_siswa = data_siswa.nama_siswa;
                    vars.nisn = data_siswa.nisn;
                    vars.kelas = data_siswa.kelas;
                }
                const isiSurat = gantiVariabel(data_template.isi_template, vars);

                // Format tanggal cetak dalam Bahasa Indonesia
                const namaBulan = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
                const tanggalCetak = `${sekarang.getDate()} ${namaBulan[sekarang.getMonth()]} ${sekarang.getFullYear()}`;

                // Susun badan surat sesuai format_surat template (keterangan / dinas / tugas)
                let badanSurat = '';
                if (data_template.format_surat === 'keterangan') {
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
                } else if (data_template.format_surat === 'tugas') {
                    badanSurat = `
                        <p style="text-indent:0;">Yang bertanda tangan di bawah ini, Kepala Sekolah Menengah Atas (SMA) Swasta Jakarta Timur, dengan ini menugaskan:</p>
                        <p class="isi-surat" style="text-indent:0;">${isiSurat}</p>
                        <p>Demikian surat tugas ini dibuat untuk dilaksanakan dengan penuh tanggung jawab. Kepada yang bersangkutan diharapkan melapor kembali setelah tugas selesai dilaksanakan.</p>`;
                } else {
                    // format 'dinas'
                    const tujuan = kepada_yth || data_template.kepada_yth_default || '.....................';
                    badanSurat = `
                        <p style="margin-bottom: 20px;">Kepada Yth.<br><strong>${tujuan}</strong><br>di tempat</p>
                        <p style="text-indent:0;">Dengan hormat,</p>
                        <p class="isi-surat">${isiSurat}</p>
                        <p>Demikian surat ini kami sampaikan, atas perhatian dan kerja sama yang diberikan kami ucapkan terima kasih.</p>`;
                }

                // Simpan riwayat cetak surat ini ke dalam tabel Log Surat Keluar (Buku Agenda TU)
                const queryLog = "INSERT INTO log_surat_keluar (nomor_urut, nomor_lengkap, id_template, id_siswa, tujuan_surat, penandatangan, operator_tu) VALUES (?, ?, ?, ?, ?, ?, 'Staf TU')";
                db.query(queryLog, [nomorUrut, nomorLengkap, id_template, id_siswa || null, kepada_yth || variabelManual.tujuan_surat || null, penandatangan], (err) => {
                    if (err) return res.status(500).send('Gagal menyimpan riwayat surat: ' + err.message);

                    // Mengeluarkan output halaman dokumen bersih berpola KOP resmi yang langsung memicu printer komputer
                    res.send(`
                        <!DOCTYPE html>
                        <html lang="id">
                        <head>
                            <title>Cetak - ${nomorLengkap.replace(/\//g, '_')}</title>
                            <style>
                                body { font-family: "Times New Roman", Times, serif; padding: 40px; line-height: 1.6; font-size: 12pt; }
                                .kop-surat { text-align: center; border-bottom: 3px double #000; padding-bottom: 10px; margin-bottom: 25px; }
                                .kop-surat h1 { margin: 0; font-size: 16pt; font-weight: bold; }
                                .kop-surat p { margin: 2px 0; font-size: 10pt; font-style: italic; }
                                .judul-surat { text-align: center; font-weight: bold; text-decoration: underline; margin-bottom: 5px; font-size: 14pt; }
                                .nomor-surat { text-align: center; margin-top: 0; margin-bottom: 30px; font-family: monospace; }
                                .isi-surat { text-align: justify; text-indent: 40px; margin-bottom: 20px; }
                                .tanda-tangan { float: right; text-align: left; width: 250px; margin-top: 20px; }
                                .tombol-aksi { position: fixed; bottom: 20px; right: 20px; background: #2563eb; color: white; padding: 12px 24px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
                                @media print { .tombol-aksi { display: none; } }
                            </style>
                        </head>
                        <body>
                            <div class="kop-surat">
                                <h1>SMA SWASTA JAKARTA TIMUR</h1>
                                <p>Jl. Raya Pendidikan No. 12, Suku Dinas Pendidikan Wilayah II, Kota Jakarta Timur, DKI Jakarta</p>
                            </div>
                            <p class="judul-surat">${data_template.nama_surat.toUpperCase()}</p>
                            <p class="nomor-surat">Nomor: ${nomorLengkap}</p>

                            ${badanSurat}

                            <div class="tanda-tangan">
                                <p>Jakarta, ${tanggalCetak}</p>
                                <p>Kepala Sekolah,</p>
                                <br><br><br><br>
                                <p style="font-weight: bold; text-decoration: underline;">${penandatangan}</p>
                                <p>NIP. 197805122005011002</p>
                            </div>

                            <button class="tombol-aksi" onclick="window.print()">🖨️ Cetak Surat ke Printer / Simpan PDF</button>
                        </body>
                        </html>
                    `);
                });
            });
        }
    });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Aplikasi berjalan lancar di port ${PORT}! (Lokal: http://localhost:${PORT})`));
