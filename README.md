# headshell eklentileri

[headshell](https://github.com/headshell/headshell)'in eklenti kataloğu.
Uygulama eklenti listesini bu deponun kökündeki [`index.json`](index.json)'dan
okur ve eklentileri buradan kurup günceller (D-071).

| Eklenti | Ne yapar | Gerektirdiği |
|---|---|---|
| [`soundcloud`](soundcloud/) | SoundCloud'da arar ve çalar | hiçbir şey |
| [`ytmusic`](ytmusic/) | YouTube Music'te arar, yt-dlp ile çalar | yt-dlp (motor indirir, sha256 doğrular) |

Eklentiler JavaScript'le yazılır ve headshell'in içine gömülü QuickJS
motorunda koşar: Python, Node ya da başka bir çalışma zamanı gerekmez. Her
eklenti bağlanacağı adresleri beyan eder ve beyan **zorlanır**.

## Kurmak

```bash
headshell plugin catalog              # ne var, ne kurulu, ne güncellenebilir
headshell plugin install soundcloud   # indirir, her dosyanın sha256'sını doğrular
headshell plugin approve soundcloud   # izinleri onayla — kurulan eklenti onay bekler
headshell plugin update               # katalogdan kurulanları güncelle
headshell plugin remove soundcloud    # kaldır, onayı unut
```

Masaüstünde: **eklentiler → katalog → kataloğu getir**.

Katalog yalnızca bu komutlarla okunur; uygulama açılırken ya da arka planda
ağa çıkmaz. Başka bir katalog (bir çatal, bir ayna) için
`HEADSHELL_PLUGIN_INDEX=<adres>`.

## Nasıl çalışır

- **Her eklenti bir dizin:** `<ad>/plugin.json` ve betiği. Nasıl yazılacağı
  ana depoda: [eklenti yazma rehberi](https://github.com/headshell/headshell/blob/master/docs/eklenti-yazma.md).
- **`index.json` üretilir, elle yazılmaz.** `headshell plugin index .` her
  manifesti uygulamanın kurulumda uyguladığı doğrulamadan geçirir, dosyaların
  sha256'sını hesaplar ve indeksi yazar. İndeks manifestin kendisini taşır:
  katalogda gösterilen izinler, kurulanın izinleridir.
- **Dosya adresleri sürüm etiketine sabitli:** `<ad>-<sürüm>`, örneğin
  `soundcloud-0.2.0`. İndeks `main`'de durur ve her zaman güncel listeyi
  verir; gösterdiği dosyalar hiç değişmez. GitHub'ın ham içerik önbelleği
  beş dakika tuttuğu için `main`'e sabitli bir adres, yeni bir sürüm
  yayımlanırken yeni indeksi eski dosyayla eşleştirebilirdi.
- **İstemci hiçbir şeye körü körüne güvenmez:** her dosyayı indeksteki
  karmayla doğrular, inen `plugin.json`'u indeksin gösterdiğiyle
  karşılaştırır; biri tutmazsa diske hiçbir şey yazmaz. Kurulan eklenti
  kullanıcı onaylayana kadar çalışmaz.
- **Elle kurulmuş ya da elle değiştirilmiş bir eklentinin üstüne
  yazılmaz.** Katalogdan kurulan her eklentinin dizininde bir köken kaydı
  (`origin.json`) durur; güncelleme yalnızca dosyaları o kayıtla aynı olan
  eklentiye dokunur.

## Yeni sürüm yayımlamak

```bash
# 1. eklentiyi değiştir, plugin.json'daki "version"ı artır
# 2. indeksi yeniden üret (şablon index.json'dan okunur)
headshell plugin index .
# 3. commit'le ve sürümün etiketini at
git commit -am "soundcloud 0.2.1: …"
git tag soundcloud-0.2.1
# 4. ikisini BİRLİKTE gönder
git push origin main soundcloud-0.2.1
```

Etiket commit'le birlikte gitmeli: indeks yeni etiketi gösteriyor ve etiket
yoksa kurulum `dosya bulunamadı (HTTP 404)` der.

Bir sürümün etiketi **taşınmaz.** Kurulu kopyalar o sürümün karmasını
kaydetti; aynı sürümle başka dosya yayımlamak onlara "yerelde değiştirilmiş"
dedirtir. Düzeltme her zaman yeni bir sürümdür.

CI her gönderimde üç şeyi denetler: indeks güncel mi (`plugin index
--check`), her sürümün etiketi var mı ve dosyaları o etiketle aynı mı, ve
`main`'de her eklenti yayımlanan katalogdan gerçekten kurulabiliyor mu.

## Kataloğa eklenti eklemek

Bir PR aç: yeni bir `<ad>/` dizini (`plugin.json` + betik) ve yeniden
üretilmiş `index.json`. Kurallar:

- **Ad:** küçük harf ASCII harf, rakam, `-`, `_`, `.`; harf ya da rakamla
  başlar. Dizin adı ile `plugin.json`'daki `name` aynı.
- **`version` zorunlu.** Güncellemeyi o yakalıyor.
- **İzinler olabildiğince dar.** Onay ekranında kullanıcı onları okuyor ve
  eklenti beyan etmediği hiçbir adrese bağlanamıyor.
- **Kendi başına kurulum yok.** Bir araç gerekiyorsa `requires` ile beyan
  edilir: platform başına sabitlenmiş sürüm, adres ve sha256. İndirmeyi
  motor yapar, root istenmez (headshell D-049, D-055).

Etiketi birleştiren bakımcı atar.

## Lisans

MIT OR Apache-2.0 — headshell'in kendisi gibi.
