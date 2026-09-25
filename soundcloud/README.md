# SoundCloud

SoundCloud'da arar ve çalar. Hiçbir şey kurman gerekmez.

```bash
headshell plugin install soundcloud
headshell plugin approve soundcloud
headshell provider test soundcloud     # "kullanılabilir" demeli
headshell play "nujabes aruarian dance"
```

`client_id` **istenmez**: eklenti SoundCloud'un web istemcisinden kendisi
keşfeder ve `host.storage`'ta önbellekler. Kendi anahtarın varsa o
kullanılır ve keşfe hiç gidilmez:

```bash
headshell secret set plugin:soundcloud client_id
```

`headshell provider test soundcloud` hangi kaynağın kullanıldığını yazar
(`sır` / `önbellek` / `keşif`) — yanlış anahtarla çalışan bir kurulum
sessizce doğru görünmesin diye (headshell D-043).

**Bilinen sınırlar**, ikisi de kasıtlı:

- **Yalnızca `progressive` (düz HTTP MP3).** Ölçüldü: parçaların %99'unda
  var. Kalan %1 yalnızca HLS sunuyor ve açık bir hata alır.
- **`[önizleme]` etiketli parçalar 30 saniyedir.** SoundCloud'un `SNIP`
  politikası; tam parça abonelik istiyor.

Keşif belgelenmemiş bir yola dayanıyor ve **haber vermeden bozulabilir**.
Bozulursa eklenti sana kendi `client_id`'ni vermeni söyler.

İzinler: `soundcloud.com`, `api-v2.soundcloud.com`, `*.sndcdn.com` (web
istemcisinin JS varlıkları ve ses akışı bu alan adının altında).
