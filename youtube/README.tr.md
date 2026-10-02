# YouTube

YouTube'da müzik videolarını bulur ve uygulamanın **resmi YouTube
oynatıcısına** verir: `youtube-nocookie.com`'dan gelen IFrame gömmesi. Hiçbir
şey indirilmez, akış çözülmez, yt-dlp yoktur. Videoyu YouTube kendisi oynatır;
reklamları da sayımı da YouTube'un kendisinindir (headshell D-086).

```bash
headshell plugin install youtube
headshell plugin approve youtube
headshell provider use youtube --for video   # şarkılarının videoları buradan gelir
headshell video "Daft Punk - Get Lucky"      # uygulamanın müzik/video düğmesinin göstereceği
```

**Şarkıların için videolar.** Video kaynağı olarak seçildiğinde, şu an çalan
görünümünü videoya çevirdiğin her an şarkının sanatçısı ve adıyla aranır.
Şarkı nereden gelirse gelsin olur: kendi dosyaların, bir sunucu, başka bir
servis. Uygulama her satırı şarkıyla tartar; cover'ı, canlı kaydı, başka
şarkıyı dışarıda bırakır ve en iyi eşleşmeyi müziğin kaldığı saniyeden
oynatır.

**Müzik kaynağı olarak.** Ana ya da müzik kaynağı seçildiğinde parçaları
yalnızca videodur. Uygulamanın penceresinde çalarlar: plak döner, video
pikabın bir köşesinde görünür. CLI ise bu parçaları sayıp atlar.

**YouTube'un kurallarını uygulama korur:** oynatıcı çalarken hep ekrandadır,
başka bir görünümün arkasında çalmaz. Üstüne hiçbir şey konmaz ve hiçbir zaman
200 × 200'den küçük olmaz. Eklenti yalnızca "hangi video" sorusunu cevaplar.

**Arama**, YouTube Music'in kendi arama ucuna (InnerTube) videos süzgeciyle
gider. Oradaki bir satır sanatçıyı ve süreyi alan olarak taşır; uygulamanın
eşleştirmesi bunlara ihtiyaç duyar. Video başlığındaki etiketler
(`(Official Video)`, sanatçı öneki) atılır, böylece şarkı şarkıyla
karşılaştırılır.

**Kapaklar:** videonun kendi küçük resmi, `i.ytimg.com`'dan; şeritsiz en
büyüğü.

İzinler: `music.youtube.com` (arama), `i.ytimg.com` (küçük resimler).
