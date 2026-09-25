# YouTube Music

YouTube Music'te arar (InnerTube) ve yt-dlp ile çözdüğü m4a akışını çalar.

**yt-dlp'yi sen kurmazsın, Python da gerekmez** — eklenti yt-dlp'yi
manifestinde platform başına beyan eder, motor senin platformunun kendi
kendine yeten ikilisini indirir (~40 MB) ve sha256'sını doğrular
(headshell D-069).

```bash
headshell plugin install ytmusic    # eklentiyi ve yt-dlp'yi indirir, ikisini de doğrular
headshell plugin approve ytmusic    # izinleri ve motorun indirdiğini gösterir
headshell provider test ytmusic     # "kullanılabilir" + yt-dlp sürümünü yazmalı
headshell play "nujabes aruarian dance"
```

**DİKKAT:** yt-dlp motorun hapsettiği bir betik değil, ayrı bir programdır:
ağ trafiği bu eklentinin izin listesiyle sınırlanmaz. Onay ekranı bunu
`motor` satırında ayrıca yazar.

Beyan edilen platformlar: Linux x86_64/aarch64 (glibc ve musl), macOS
(evrensel ikili, Intel + Apple Silicon), Windows x86_64/x86/ARM64. **32 bit
ARM Linux (`linux-arm`) ve 32 bit x86 Linux için yt-dlp tek dosyalık yayın
yapmıyor**; BSD'ler için hiç yayın yok. Oralarda eklenti **yüklenmez** ve
`headshell plugin list` "bu platform için yayın yok" der.

Veri merkezi adreslerinde YouTube bot duvarı çıkarabiliyor (headshell
D-061). Çerez verirsen yt-dlp'ye dosya olarak geçirilir, motor kapanınca
silinir:

```bash
headshell secret set plugin:ytmusic cookies    # Netscape biçimli çerez dosyasının içeriği
```

## yt-dlp sürümü

**Sürümü bu depo sabitliyor** (headshell D-055) ve bunun bir bedeli var:
YouTube yt-dlp'yi bozduğunda kullanıcı kendi paket yöneticisiyle güncelleyip
kurtulamaz, buraya yeni bir sürüm yayımlanmasını bekler — `headshell plugin
update` onu getirir ve yeni ikiliyi indirir. Güncelleme çıktısı aracın
değiştiğini ayrıca yazar.

Güncellerken **her platformun** karmasını yt-dlp'nin yayımladığı
`SHA2-256SUMS` dosyasından al ve eklentinin `version`'ını artır.

**Bilinen sınırlar**, üçü de ölçülmüş:

- **Ses m4a (AAC-LC, ~130 kbps).** headshell'in symphonia'sında ne opus
  çözücüsü ne webm kabı var; çalınamayan yüksek kalite yerine çalınabilen
  düşük kalite seçildi.
- **Akış `Range: bytes=0-` başlığıyla çekiliyor.** Bu başlık olmadan aynı
  adres 32 KB/s veriyor, onunla 8 MB/s.
- **yt-dlp JS çalışma zamanı istemeye başladı.** 2026.08.19 sürümü "JS
  runtimes: none" deyip YouTube çözümünü JS çalışma zamanı olmadan
  sürdürüyor ama bunun **kullanımdan kaldırıldığını** uyarıyor (ölçüldü,
  headshell D-069). O yol kapandığında motorun bir JS çalışma zamanını da
  aynı `requires` mekanizmasıyla indirmesi gerekecek.
