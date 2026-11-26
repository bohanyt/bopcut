[Read in English](README.en.md)

# bopencut — satu timeline untuk kamu dan agenmu

**bopencut** adalah editor video web tempat **kamu dan agen mengedit timeline yang sama**. Agen membaca sumbermu dan menyusun draf video yang kamu minta; kamu menggeser, memotong, dan menata di UI seperti CapCut; lalu agen merapikan bagian yang kamu tunjuk. Semua perubahan agen bisa di-Undo, dan editanmu tidak tertimpa.

> bopencut adalah fork dari **OpenCut (classic)** buatan tim [OpenCut](https://github.com/opencut-app/opencut-classic), lisensi MIT (lihat [`LICENSE`](LICENSE)). Editor dasarnya sepenuhnya karya mereka. README asli OpenCut: [`docs/opencut-original-readme.md`](docs/opencut-original-readme.md).

## Yang bisa dilakukan

**Kerja bareng agen**
- **Pertahankan edit saat agen menulis ulang.** Draft agen bisa mempertahankan bagian klip yang kamu edit, termasuk koreksi teks, warna, dan posisi. Izinkan agen mengubahnya lagi dari menu klip.
- **Agen tahu isi timeline:** setiap perubahan ditulis ke folder kerja sebagai JSON (trek, item, waktu, posisi, catatan).
- **Agen ikut mengedit:** agen mengirim draf per item (tambah, ubah, hapus). Editor menerapkannya dalam ±2 detik sebagai **satu langkah Undo**, dan item yang diubah langsung terpilih.
- **Catatan dua arah:** beri catatan pada rentang waktu, item, atau area yang ditandai dengan kotak di pratinjau. Agen bisa membaca, membalas, dan menandai catatan selesai.
- **Agen melihat frame:** agen bisa meminta gambar frame pada detik mana pun.
- **Tinjau rentang waktu.** Baca kata yang tersimpan lewat `transcript-view`, pratinjau penggantian narasi lewat `narration-plan`, atau buat PNG berisi frame, bentuk gelombang audio, kata, dan batas klip lewat `view`. Editor boleh tetap tertutup. [CLI agen](AGENT.md#agent-cli)
- **Buang jeda kosong dan suara pengisi.** `silence-plan` mengusulkan potongan yang pas di frame untuk jeda dan suara seperti "umm", berdasarkan kata yang tersimpan, tanpa pernah memotong ucapan yang belum punya kata. Bisa diterapkan sebagai satu langkah Undo. [CLI agen](AGENT.md#agent-cli)
- **Tinjau hasil ekspor.** Agen bisa memeriksa file hasil ekspor dan timeline yang tersimpan, dengan temuan bertanda waktu dan rangkaian frame sebagai bukti. [CLI agen](AGENT.md#agent-cli)
- **Narasi draf pakai alat suaramu sendiri.** Arahkan `BOPENCUT_TTS` ke perintah text-to-speech apa pun, lalu `voice` menyimpan tiap kalimat sebagai WAV beserta timing per kata, siap dipakai di timeline, potongan per kata, dan caption. Tidak ada mesin suara bawaan. [CLI agen](AGENT.md#agent-cli)
- **Ambil potongan video dari link:** cukup link + waktu mulai/selesai (misalnya 20 detik dari live 3 jam). Yang diunduh hanya bagian itu, lewat yt-dlp, dengan potongan yang pas di frame. Bisa dari draf agen, dari CLI, atau dari tombol link di panel Assets.
- **Sound effect tinggal sebut nama:** cari di folder SFX-mu sendiri dan di Myinstants (tanpa akun). Bisa dari tab Library di panel Sounds, atau agen cukup menulis `sfx: "vine boom"` di draf. Suara yang pernah diambil tersimpan dan ikut jadi library.
- **Lagu tinggal sebut judul:** dari folder musikmu atau dicari online (hanya suaranya, lewat yt-dlp), langsung dinormalisasi kerasnya. Agen juga bisa membuat musik otomatis mengecil saat ada suara bicara (*ducking*), sebagai keyframe volume yang tetap bisa kamu geser.
- **Camera shake:** getaran kamera di atas posisi/zoom milikmu sendiri, dari goyang tangan halus sampai hentakan yang meredam (intensitas bisa di-keyframe).
- **Caption bergaya:** satu elemen per frasa dengan timing per kata, outline dua lapis, glow/bayangan, warna untuk kata penting, sorotan kata yang sedang diucapkan, dan mode kata muncul satu per satu (fade/pop). Gaya bisa disimpan sebagai preset milikmu sendiri.
- **Drag-drop gambar dari browser:** seret gambar dari Google Images atau halaman web mana pun ke panel Assets atau timeline (seperti di Photopea), atau tempel link gambar.
- **Agen belajar seleramu:** editanmu pada item buatan agen dicatat dan diringkas menjadi kandidat aturan selera.

**Editor**
- **Rekam suara.** Gunakan mikrofon di timeline atau Shift+R, lalu rekam di playhead dan pilih take.
- Proyek dan media disimpan **di folder, bukan di browser**, jadi bisa dibuka dari browser mana pun di laptop yang sama.
- Bahan motion graphic: ikon (Iconify), garis/panah/path dengan efek "digambar", grup objek.
- Model 3D (GLB/glTF) yang dirender per frame.
- Kualitas preview Penuh / ½ / ¼; export selalu resolusi penuh.
- GIF yang di-drop otomatis menjadi video bergerak.

## Menjalankan

Butuh [Bun](https://bun.sh); `ffmpeg` di PATH dipakai untuk mengubah GIF menjadi video. Untuk mengambil potongan video dari link, pasang juga [yt-dlp](https://github.com/yt-dlp/yt-dlp) (pengaturannya ada di `AGENT.md`). Tidak perlu akun, database, atau Docker.

Jika `apps/web/.env.local` belum ada, salin `apps/web/.env.example` ke lokasi itu untuk build produksi lokal. Jalankan `bun --no-env-file script/start-local.mjs` dari repositori. Di Windows, Anda juga bisa menjalankan `script\start-local.cmd`. Peluncur memeriksa pembaruan fast-forward ke `origin/main` saat port editor kosong dan checkout bersih. Versi baru dibangun dan dijalankan sebelum checkout diperbarui. Jika pembaruan gagal, peluncur menjalankan hasil build untuk commit saat ini. Tambahkan `--no-update` atau atur `BOPENCUT_AUTO_UPDATE=0` untuk tetap memakai versi saat ini. Gunakan `--port=3100` untuk memilih port loopback lain.

Pada checkout Windows yang baru, peluncuran pertama menyiapkan sekitar 1,7 GB berkas di `.git/bopencut-local`, termasuk sekitar 1,4 GB dependensi dan 120 MB untuk build mandiri.

Peluncur menjalankan satu editor per checkout dan menyimpan build saat ini serta build sebelumnya yang berhasil dijalankan. Hasil pembaruan dicatat di `.bopencut-updates.jsonl` di samping folder data. Peluncur memberi peringatan jika pembaruan mengubah migrasi proyek, karena proyek yang dimigrasikan mungkin memerlukan editor versi baru di komputer lain.

Untuk pengembangan tanpa pembaruan otomatis:

```
bun install
cd apps/web && bunx next dev --turbopack -H 127.0.0.1 -p 3000
```

Buka `http://127.0.0.1:3000/projects`.

Gunakan tombol **EN / ID** di header untuk memilih bahasa Inggris atau Bahasa Indonesia. Pilihanmu akan diingat di browser itu.

## Di mana data disimpan

| Apa | Lokasi default | Ganti dengan (`apps/web/.env.local`) |
|---|---|---|
| Proyek dan media | `<repo>/workspace/projects/` | `BOPENCUT_DATA` |
| Folder kerja agen (sync, draf, frame, log editan) | `<repo>/workspace/` | `AGENT_WORKSPACE` |
| Akar aset yang boleh dibaca agen | = `AGENT_WORKSPACE` | `AGENT_FILES_ROOT` |

`BOPENCUT_DATA` menunjuk ke folder induk `projects/`. `workspace/` tidak masuk Git. Kalau memakai folder lain, pastikan folder itu juga tidak dikomit. Project lama yang masih tersimpan di browser, beserta medianya, disalin otomatis ke folder saat halaman Projects memuat daftar project (sebelum project mana pun dibuka), tanpa menghapus aslinya.

## Memakai bopencut dengan agen lokal

Jalankan bopencut, buka agen coding di folder repo, lalu minta **"baca `AGENTS.md`, lalu bantu aku membuat video dari sumber-sumber ini."** Berikan tautan, artikel, dokumen, atau folder footage. Skrip boleh disertakan. Agen merangkum isi sumber, bertanya video apa yang ingin dibuat, lalu menyusun draf, memeriksa hasilnya, dan mengekspor video dari timeline bersama.

## Dokumen

- [GOAL.md](GOAL.md): tujuan, alur kerja, dan tahapan.
- [AGENT.md](AGENT.md): protokol folder kerja agen (format bundle, draf, catatan, frame, selera).
- [AGENTS.md](AGENTS.md): titik masuk untuk agen (cara kerja di bopencut, dan aturan kalau mengubah kodenya).

## Lisensi

MIT, sama seperti OpenCut. Lihat [`LICENSE`](LICENSE).


### Penggeseran playhead lebih mulus

Pengaturan proyek menyediakan **Penggeseran playhead mulus (salinan ringan)**. FFmpeg opsional menyiapkan salinan lokal 540p untuk menggeser playhead dengan penunjuk. Pratinjau saat dijeda, pemutaran, dan ekspor memakai media asli. Tembolok salinan dapat dihapus dari pengaturan.
