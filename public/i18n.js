/* KarCast car page translations (V81, CR-20261021-I18N-GLOBAL E; V82 live switching, CR-20261021-PAGE-LANGUAGE-SYNC B).
 * gettext-style: the English text is the key, so diagnostics, telemetry and tests keep the English source.
 * Only text is translated. The video/touch area (#stream-container) always stays left-to-right. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KarCastI18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SUPPORTED = ['en', 'ar', 'es', 'fr', 'de', 'zh-CN', 'ja', 'pt'];
  const RTL = new Set(['ar']);
  const HEAD_UNIT = "Android Auto's head-unit server is not responding. On the phone open Android Auto settings, then the menu: Stop head unit server, then Start head unit server. KarCast keeps retrying.";
  const D = {
    'Connected': { ar: 'متصل', es: 'Conectado', fr: 'Connecté', de: 'Verbunden', 'zh-CN': '已连接', ja: '接続済み', pt: 'Conectado' },
    'Connect your vehicle': { ar: 'اربط سيارتك', es: 'Conecta tu vehículo', fr: 'Connectez votre véhicule', de: 'Fahrzeug verbinden', 'zh-CN': '连接您的车辆', ja: '車両を接続', pt: 'Conecte seu veículo' },
    'Follow these steps on your phone.': { ar: 'اتبع هذه الخطوات على هاتفك.', es: 'Sigue estos pasos en tu teléfono.', fr: 'Suivez ces étapes sur votre téléphone.', de: 'Folgen Sie diesen Schritten auf Ihrem Telefon.', 'zh-CN': '请在手机上按以下步骤操作。', ja: 'スマートフォンで次の手順を行ってください。', pt: 'Siga estas etapas no seu celular.' },
    'Pair phone': { ar: 'إقران الهاتف', es: 'Vincular teléfono', fr: 'Associer le téléphone', de: 'Telefon koppeln', 'zh-CN': '配对手机', ja: 'スマートフォンをペアリング', pt: 'Parear celular' },
    'Phone pairing code': { ar: 'رمز إقران الهاتف', es: 'Código de vinculación del teléfono', fr: "Code d'association du téléphone", de: 'Kopplungscode des Telefons', 'zh-CN': '手机配对码', ja: 'スマートフォンのペアリングコード', pt: 'Código de pareamento do celular' },
    '6-digit pairing code': { ar: 'رمز إقران من 6 أرقام', es: 'Código de 6 dígitos', fr: 'Code à 6 chiffres', de: '6-stelliger Kopplungscode', 'zh-CN': '6 位配对码', ja: '6桁のペアリングコード', pt: 'Código de 6 dígitos' },
    'Open KarCast': { ar: 'افتح KarCast', es: 'Abre KarCast', fr: 'Ouvrez KarCast', de: 'KarCast öffnen', 'zh-CN': '打开 KarCast', ja: 'KarCast を開く', pt: 'Abra o KarCast' },
    'Launch the app on your phone.': { ar: 'شغّل التطبيق على هاتفك.', es: 'Inicia la app en tu teléfono.', fr: "Lancez l'application sur votre téléphone.", de: 'Starten Sie die App auf Ihrem Telefon.', 'zh-CN': '在手机上启动应用。', ja: 'スマートフォンでアプリを起動します。', pt: 'Abra o app no seu celular.' },
    'Tap Start Connection': { ar: 'اضغط «بدء الاتصال»', es: 'Toca «Iniciar conexión»', fr: 'Touchez « Démarrer la connexion »', de: 'Tippen Sie auf „Verbindung starten“', 'zh-CN': '点按“开始连接”', ja: '「接続を開始」をタップ', pt: 'Toque em "Iniciar conexão"' },
    'Keep KarCast running while you connect.': { ar: 'أبقِ KarCast مفتوحًا أثناء الاتصال.', es: 'Mantén KarCast abierto mientras se conecta.', fr: 'Laissez KarCast ouvert pendant la connexion.', de: 'Lassen Sie KarCast während der Verbindung geöffnet.', 'zh-CN': '连接期间请保持 KarCast 运行。', ja: '接続中は KarCast を開いたままにしてください。', pt: 'Mantenha o KarCast aberto durante a conexão.' },
    'Phone connected': { ar: 'تم توصيل الهاتف', es: 'Teléfono conectado', fr: 'Téléphone connecté', de: 'Telefon verbunden', 'zh-CN': '手机已连接', ja: 'スマートフォン接続済み', pt: 'Celular conectado' },
    'Done': { ar: 'تم', es: 'Listo', fr: 'Terminé', de: 'Fertig', 'zh-CN': '完成', ja: '完了', pt: 'Concluído' },
    'Starting Android Auto': { ar: 'جارٍ تشغيل Android Auto', es: 'Iniciando Android Auto', fr: "Démarrage d'Android Auto", de: 'Android Auto wird gestartet', 'zh-CN': '正在启动 Android Auto', ja: 'Android Auto を起動中', pt: 'Iniciando o Android Auto' },
    'In progress': { ar: 'قيد التنفيذ', es: 'En curso', fr: 'En cours', de: 'Läuft', 'zh-CN': '进行中', ja: '進行中', pt: 'Em andamento' },
    'Ready to drive': { ar: 'جاهز للقيادة', es: 'Listo para conducir', fr: 'Prêt à rouler', de: 'Bereit zur Fahrt', 'zh-CN': '准备驾驶', ja: '運転の準備完了', pt: 'Pronto para dirigir' },
    'Up next': { ar: 'التالي', es: 'Siguiente', fr: 'Ensuite', de: 'Als Nächstes', 'zh-CN': '下一步', ja: '次へ', pt: 'A seguir' },
    'Waiting for your phone…': { ar: 'في انتظار هاتفك…', es: 'Esperando tu teléfono…', fr: 'En attente de votre téléphone…', de: 'Warten auf Ihr Telefon …', 'zh-CN': '正在等待您的手机…', ja: 'スマートフォンを待っています…', pt: 'Aguardando seu celular…' },
    'This screen will connect automatically.': { ar: 'ستتصل هذه الشاشة تلقائيًا.', es: 'Esta pantalla se conectará automáticamente.', fr: "Cet écran se connectera automatiquement.", de: 'Dieser Bildschirm verbindet sich automatisch.', 'zh-CN': '此屏幕将自动连接。', ja: 'この画面は自動的に接続されます。', pt: 'Esta tela se conectará automaticamente.' },
    'Connection progress': { ar: 'تقدم الاتصال', es: 'Progreso de la conexión', fr: 'Progression de la connexion', de: 'Verbindungsfortschritt', 'zh-CN': '连接进度', ja: '接続の進行状況', pt: 'Progresso da conexão' },
    'Connect the car to the phone hotspot, then keep this page open.': { ar: 'اربط السيارة بنقطة اتصال الهاتف، ثم أبقِ هذه الصفحة مفتوحة.', es: 'Conecta el coche al punto de acceso del teléfono y mantén esta página abierta.', fr: "Connectez la voiture au point d'accès du téléphone, puis laissez cette page ouverte.", de: 'Verbinden Sie das Auto mit dem Hotspot des Telefons und lassen Sie diese Seite geöffnet.', 'zh-CN': '请将汽车连接到手机热点，并保持此页面打开。', ja: '車をスマートフォンのホットスポットに接続し、このページを開いたままにしてください。', pt: 'Conecte o carro ao hotspot do celular e mantenha esta página aberta.' },
    'Waiting for phone...': { ar: 'في انتظار الهاتف...', es: 'Esperando el teléfono...', fr: 'En attente du téléphone...', de: 'Warten auf Telefon ...', 'zh-CN': '正在等待手机...', ja: 'スマートフォンを待っています...', pt: 'Aguardando o celular...' },
    'Looking for phone...': { ar: 'جارٍ البحث عن الهاتف...', es: 'Buscando el teléfono...', fr: 'Recherche du téléphone...', de: 'Telefon wird gesucht ...', 'zh-CN': '正在查找手机...', ja: 'スマートフォンを探しています...', pt: 'Procurando o celular...' },
    'Looking for your phone…': { ar: 'جارٍ البحث عن هاتفك…', es: 'Buscando tu teléfono…', fr: 'Recherche de votre téléphone…', de: 'Ihr Telefon wird gesucht …', 'zh-CN': '正在查找您的手机…', ja: 'スマートフォンを探しています…', pt: 'Procurando seu celular…' },
    'Keep KarCast open after tapping Start Connection.': { ar: 'أبقِ KarCast مفتوحًا بعد الضغط على «بدء الاتصال».', es: 'Mantén KarCast abierto después de tocar «Iniciar conexión».', fr: 'Laissez KarCast ouvert après avoir touché « Démarrer la connexion ».', de: 'Lassen Sie KarCast nach „Verbindung starten“ geöffnet.', 'zh-CN': '点按“开始连接”后，请保持 KarCast 打开。', ja: '「接続を開始」をタップした後も KarCast を開いたままにしてください。', pt: 'Mantenha o KarCast aberto depois de tocar em "Iniciar conexão".' },
    'Connecting...': { ar: 'جارٍ الاتصال...', es: 'Conectando...', fr: 'Connexion...', de: 'Verbinden ...', 'zh-CN': '正在连接...', ja: '接続中...', pt: 'Conectando...' },
    'Connecting your vehicle': { ar: 'جارٍ ربط سيارتك', es: 'Conectando tu vehículo', fr: 'Connexion de votre véhicule', de: 'Fahrzeug wird verbunden', 'zh-CN': '正在连接您的车辆', ja: '車両を接続しています', pt: 'Conectando seu veículo' },
    'Preparing Android Auto for your screen.': { ar: 'جارٍ تجهيز Android Auto لشاشتك.', es: 'Preparando Android Auto para tu pantalla.', fr: 'Préparation d’Android Auto pour votre écran.', de: 'Android Auto wird für Ihren Bildschirm vorbereitet.', 'zh-CN': '正在为您的屏幕准备 Android Auto。', ja: '画面用に Android Auto を準備しています。', pt: 'Preparando o Android Auto para sua tela.' },
    'Setting things up…': { ar: 'جارٍ الإعداد…', es: 'Preparando todo…', fr: 'Configuration en cours…', de: 'Wird eingerichtet …', 'zh-CN': '正在设置…', ja: '準備しています…', pt: 'Preparando tudo…' },
    'Android Auto will appear here automatically.': { ar: 'سيظهر Android Auto هنا تلقائيًا.', es: 'Android Auto aparecerá aquí automáticamente.', fr: "Android Auto s'affichera ici automatiquement.", de: 'Android Auto erscheint hier automatisch.', 'zh-CN': 'Android Auto 将自动显示在这里。', ja: 'Android Auto はここに自動的に表示されます。', pt: 'O Android Auto aparecerá aqui automaticamente.' },
    'Vehicle Connected': { ar: 'السيارة متصلة', es: 'Vehículo conectado', fr: 'Véhicule connecté', de: 'Fahrzeug verbunden', 'zh-CN': '车辆已连接', ja: '車両接続済み', pt: 'Veículo conectado' },
    'Android Auto is active.': { ar: 'Android Auto نشط.', es: 'Android Auto está activo.', fr: 'Android Auto est actif.', de: 'Android Auto ist aktiv.', 'zh-CN': 'Android Auto 已启用。', ja: 'Android Auto は有効です。', pt: 'O Android Auto está ativo.' },
    'Connected & Streaming Live!': { ar: 'متصل ويبث مباشرة!', es: '¡Conectado y transmitiendo en vivo!', fr: 'Connecté et diffusion en direct !', de: 'Verbunden und Live-Übertragung!', 'zh-CN': '已连接，正在实时传输！', ja: '接続済み・ライブ配信中！', pt: 'Conectado e transmitindo ao vivo!' },
    'Android Auto is streaming to your browser.': { ar: 'يبث Android Auto إلى متصفحك.', es: 'Android Auto se está transmitiendo a tu navegador.', fr: 'Android Auto est diffusé dans votre navigateur.', de: 'Android Auto wird an Ihren Browser übertragen.', 'zh-CN': 'Android Auto 正在传输到您的浏览器。', ja: 'Android Auto をブラウザに配信しています。', pt: 'O Android Auto está sendo transmitido para seu navegador.' },
    'Enter the pairing code from KarCast on your phone, or open its copied pairing link.': { ar: 'أدخل رمز الإقران من KarCast على هاتفك، أو افتح رابط الإقران المنسوخ.', es: 'Introduce el código de vinculación de KarCast en tu teléfono o abre el enlace de vinculación copiado.', fr: "Saisissez le code d'association de KarCast sur votre téléphone ou ouvrez le lien d'association copié.", de: 'Geben Sie den Kopplungscode aus KarCast auf Ihrem Telefon ein oder öffnen Sie den kopierten Kopplungslink.', 'zh-CN': '请输入手机上 KarCast 显示的配对码，或打开已复制的配对链接。', ja: 'スマートフォンの KarCast に表示されたペアリングコードを入力するか、コピーしたペアリングリンクを開いてください。', pt: 'Digite o código de pareamento do KarCast no seu celular ou abra o link de pareamento copiado.' },
    'Connection opened in another browser. Reload to connect here.': { ar: 'فُتح الاتصال في متصفح آخر. أعد تحميل الصفحة للاتصال هنا.', es: 'La conexión se abrió en otro navegador. Recarga para conectar aquí.', fr: 'La connexion a été ouverte dans un autre navigateur. Rechargez pour vous connecter ici.', de: 'Die Verbindung wurde in einem anderen Browser geöffnet. Neu laden, um hier zu verbinden.', 'zh-CN': '连接已在另一个浏览器中打开。请重新加载以在此连接。', ja: '別のブラウザで接続が開かれました。ここで接続するには再読み込みしてください。', pt: 'A conexão foi aberta em outro navegador. Recarregue para conectar aqui.' },
    'This pairing code has expired. Enter the current code shown on your phone.': { ar: 'انتهت صلاحية رمز الإقران هذا. أدخل الرمز الحالي الظاهر على هاتفك.', es: 'Este código de vinculación ha caducado. Introduce el código actual que aparece en tu teléfono.', fr: "Ce code d'association a expiré. Saisissez le code actuel affiché sur votre téléphone.", de: 'Dieser Kopplungscode ist abgelaufen. Geben Sie den aktuellen Code von Ihrem Telefon ein.', 'zh-CN': '此配对码已过期。请输入手机上显示的当前配对码。', ja: 'このペアリングコードは期限切れです。スマートフォンに表示されている現在のコードを入力してください。', pt: 'Este código de pareamento expirou. Digite o código atual exibido no seu celular.' },
    'This code is already in use by another browser. Close the other browser, or tap Stop and Start on your phone for a new code.': { ar: 'هذا الرمز مستخدم بالفعل في متصفح آخر. أغلق المتصفح الآخر، أو اضغط «إيقاف» ثم «بدء» على هاتفك للحصول على رمز جديد.', es: 'Otro navegador ya está usando este código. Cierra el otro navegador o toca Detener e Iniciar en tu teléfono para obtener un código nuevo.', fr: 'Ce code est déjà utilisé par un autre navigateur. Fermez l’autre navigateur ou touchez Arrêter puis Démarrer sur votre téléphone pour obtenir un nouveau code.', de: 'Dieser Code wird bereits von einem anderen Browser verwendet. Schließen Sie den anderen Browser oder tippen Sie auf dem Telefon auf Stopp und Start, um einen neuen Code zu erhalten.', 'zh-CN': '此配对码已被另一个浏览器使用。请关闭另一个浏览器，或在手机上点按“停止”后再点按“开始”以获取新的配对码。', ja: 'このコードは別のブラウザで使用中です。別のブラウザを閉じるか、スマートフォンで停止して開始し、新しいコードを取得してください。', pt: 'Este código já está em uso em outro navegador. Feche o outro navegador ou toque em Parar e Iniciar no celular para obter um novo código.' },
    'Pairing code not accepted. Check the code on your phone. If it is correct, another browser may already be connected: tap Stop and Start on your phone for a new code.': { ar: 'لم يُقبل رمز الإقران. تحقق من الرمز على هاتفك. إذا كان صحيحًا فقد يكون متصفح آخر متصلًا بالفعل: اضغط «إيقاف» ثم «بدء» على هاتفك للحصول على رمز جديد.', es: 'No se aceptó el código. Comprueba el código en tu teléfono. Si es correcto, puede que otro navegador ya esté conectado: toca Detener e Iniciar en tu teléfono para obtener un código nuevo.', fr: "Code d'association refusé. Vérifiez le code sur votre téléphone. S'il est correct, un autre navigateur est peut-être déjà connecté : touchez Arrêter puis Démarrer sur votre téléphone pour obtenir un nouveau code.", de: 'Kopplungscode nicht akzeptiert. Prüfen Sie den Code auf Ihrem Telefon. Wenn er stimmt, ist eventuell bereits ein anderer Browser verbunden: Tippen Sie auf dem Telefon auf Stopp und Start, um einen neuen Code zu erhalten.', 'zh-CN': '配对码未被接受。请检查手机上的配对码。如果配对码正确，可能已有其他浏览器连接：请在手机上点按“停止”后再点按“开始”以获取新的配对码。', ja: 'ペアリングコードが受け付けられませんでした。スマートフォンのコードを確認してください。正しい場合は、別のブラウザがすでに接続している可能性があります。スマートフォンで停止して開始し、新しいコードを取得してください。', pt: 'Código de pareamento não aceito. Verifique o código no celular. Se estiver correto, outro navegador pode já estar conectado: toque em Parar e Iniciar no celular para obter um novo código.' },
    'The video stream stopped. Reconnecting...': { ar: 'توقف بث الفيديو. جارٍ إعادة الاتصال...', es: 'La transmisión de vídeo se detuvo. Reconectando...', fr: 'Le flux vidéo s’est arrêté. Reconnexion...', de: 'Der Videostream wurde unterbrochen. Verbindung wird wiederhergestellt ...', 'zh-CN': '视频流已停止。正在重新连接...', ja: 'ビデオストリームが停止しました。再接続しています...', pt: 'A transmissão de vídeo parou. Reconectando...' },
    'The local video connection was interrupted. Reconnecting...': { ar: 'انقطع اتصال الفيديو المحلي. جارٍ إعادة الاتصال...', es: 'Se interrumpió la conexión de vídeo local. Reconectando...', fr: 'La connexion vidéo locale a été interrompue. Reconnexion...', de: 'Die lokale Videoverbindung wurde unterbrochen. Verbindung wird wiederhergestellt ...', 'zh-CN': '本地视频连接已中断。正在重新连接...', ja: 'ローカルのビデオ接続が中断されました。再接続しています...', pt: 'A conexão de vídeo local foi interrompida. Reconectando...' },
    'This browser could not decode Android Auto video. Please update the vehicle browser and reload.': { ar: 'تعذّر على هذا المتصفح فك ترميز فيديو Android Auto. يُرجى تحديث متصفح السيارة وإعادة تحميل الصفحة.', es: 'Este navegador no pudo decodificar el vídeo de Android Auto. Actualiza el navegador del vehículo y recarga la página.', fr: "Ce navigateur n'a pas pu décoder la vidéo Android Auto. Mettez à jour le navigateur du véhicule et rechargez la page.", de: 'Dieser Browser konnte das Android-Auto-Video nicht dekodieren. Bitte aktualisieren Sie den Fahrzeugbrowser und laden Sie die Seite neu.', 'zh-CN': '此浏览器无法解码 Android Auto 视频。请更新车载浏览器并重新加载。', ja: 'このブラウザでは Android Auto の映像をデコードできませんでした。車両のブラウザを更新して再読み込みしてください。', pt: 'Este navegador não conseguiu decodificar o vídeo do Android Auto. Atualize o navegador do veículo e recarregue a página.' },
    'Video paused — reconnecting…': { ar: 'توقف الفيديو مؤقتًا — جارٍ إعادة الاتصال…', es: 'Vídeo en pausa: reconectando…', fr: 'Vidéo en pause — reconnexion…', de: 'Video pausiert – Verbindung wird wiederhergestellt …', 'zh-CN': '视频已暂停——正在重新连接…', ja: 'ビデオ一時停止中 — 再接続しています…', pt: 'Vídeo pausado — reconectando…' },
    [HEAD_UNIT]: { ar: 'خادم وحدة الرأس في Android Auto لا يستجيب. على الهاتف افتح إعدادات Android Auto، ثم القائمة: «إيقاف خادم وحدة الرأس» ثم «تشغيل خادم وحدة الرأس». يواصل KarCast المحاولة.', es: 'El servidor de unidad principal de Android Auto no responde. En el teléfono, abre los ajustes de Android Auto y, en el menú, toca Detener el servidor de unidad principal y luego Iniciar el servidor de unidad principal. KarCast sigue reintentando.', fr: "Le serveur d'unité principale d'Android Auto ne répond pas. Sur le téléphone, ouvrez les paramètres d'Android Auto, puis le menu : Arrêter le serveur d'unité principale, puis Démarrer le serveur d'unité principale. KarCast continue de réessayer.", de: 'Der Head-Unit-Server von Android Auto antwortet nicht. Öffnen Sie auf dem Telefon die Android-Auto-Einstellungen und im Menü „Head-Unit-Server beenden“ und dann „Head-Unit-Server starten“. KarCast versucht es weiter.', 'zh-CN': 'Android Auto 的车机服务器无响应。请在手机上打开 Android Auto 设置，然后在菜单中依次选择“停止车机服务器”和“启动车机服务器”。KarCast 会继续重试。', ja: 'Android Auto のヘッドユニットサーバーが応答していません。スマートフォンで Android Auto の設定を開き、メニューから「ヘッドユニット サーバーを停止」、続いて「ヘッドユニット サーバーを起動」を選んでください。KarCast は再試行を続けます。', pt: 'O servidor da central multimídia do Android Auto não está respondendo. No celular, abra as configurações do Android Auto e, no menu, toque em Parar servidor da central multimídia e depois em Iniciar servidor da central multimídia. O KarCast continua tentando.' },
  };
  const NOTICE_CODES = { HEAD_UNIT_SERVER_NOT_RESPONDING: HEAD_UNIT };

  function normalize(tag) {
    if (typeof tag !== 'string' || !tag) return null;
    const t = tag.trim().replace('_', '-');
    const lower = t.toLowerCase();
    if (lower === 'zh' || lower.startsWith('zh-cn') || lower.startsWith('zh-sg') || lower.startsWith('zh-hans')) return 'zh-CN';
    if (lower.startsWith('zh')) return null; // Traditional Chinese: English until a zh-TW translation exists.
    const base = lower.split('-')[0];
    return SUPPORTED.includes(base) ? base : null;
  }
  /** ?lang= from the phone's link, then the language the phone last sent (remembered), then the browser, then English.
   *  A live value from the phone (phone_language / joined) overrides all of these when it arrives. */
  function choose(search, languages, remembered) {
    try { const p = normalize(new URLSearchParams(search || '').get('lang')); if (p) return p; } catch (_) {}
    const r = normalize(remembered); if (r) return r;
    for (const l of languages || []) { const n = normalize(l); if (n) return n; }
    return 'en';
  }
  const STORE = 'karcast_lang';
  function recall(storage) { try { return normalize(storage && storage.getItem(STORE)); } catch (_) { return null; } }
  /** Remember the phone's explicit language for the next visit; null (phone on Auto) forgets it. */
  function remember(storage, tag) {
    try { const t = normalize(tag); if (!storage) return; if (t) storage.setItem(STORE, t); else storage.removeItem(STORE); } catch (_) {}
  }
  let current = 'en';
  function setLanguage(lang) { current = SUPPORTED.includes(lang) ? lang : 'en'; return current; }
  function tr(text) {
    if (current === 'en' || typeof text !== 'string') return text;
    const entry = D[text] || D[text.trim()];
    return (entry && entry[current]) || text;
  }
  function notice(code, message) { return NOTICE_CODES[code] ? tr(NOTICE_CODES[code]) : tr(message); }
  // V82: the English source of every translated node, so the page can switch language again without a reload.
  const sources = typeof WeakMap === 'function' ? new WeakMap() : null;
  const attrSources = typeof WeakMap === 'function' ? new WeakMap() : null;
  /** Sets an element's text from its English source and remembers the source for later switches. */
  function text(el, english) {
    if (!el) return english;
    const shown = tr(english);
    try { if (sources) sources.set(el, { english }); } catch (_) {}
    el.textContent = shown;
    return shown;
  }
  /** Same for a phone notice (code first, then message). */
  function noticeText(el, code, message) {
    if (!el) return message;
    const shown = notice(code, message);
    try { if (sources) sources.set(el, { code, message }); } catch (_) {}
    el.textContent = shown;
    return shown;
  }
  /** Translates static text nodes and accessible attributes once; the video area is pinned left-to-right. */
  function apply(doc) {
    if (!doc) return;
    const html = doc.documentElement;
    if (html) { html.setAttribute('lang', current); html.setAttribute('dir', RTL.has(current) ? 'rtl' : 'ltr'); }
    const stream = doc.getElementById && doc.getElementById('stream-container');
    if (stream) stream.setAttribute('dir', 'ltr');
    if (!doc.body || !doc.createTreeWalker) return;
    const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let src = sources && sources.get(n);
      if (!src) { const raw = n.nodeValue, key = raw && raw.trim(); if (!key || !D[key]) continue; src = { raw, key }; if (sources) sources.set(n, src); }
      if (src.raw !== undefined) n.nodeValue = current === 'en' ? src.raw : src.raw.replace(src.key, D[src.key][current] || src.key);
    }
    for (const el of doc.querySelectorAll('[placeholder],[aria-label],[title]')) {
      let src = attrSources && attrSources.get(el);
      if (!src) {
        src = { attrs: {} };
        for (const a of ['placeholder', 'aria-label', 'title']) { const v = el.getAttribute(a); if (v && D[v]) src.attrs[a] = v; }
        if (attrSources) attrSources.set(el, src);
      }
      for (const [a, v] of Object.entries(src.attrs)) el.setAttribute(a, current === 'en' ? v : (D[v][current] || v));
    }
  }
  /** V82: switch the page language now: <html lang/dir>, static text and every element set through text()/noticeText(). */
  function refresh(doc, elements) {
    apply(doc);
    for (const el of elements || []) {
      const src = el && sources && sources.get(el);
      if (!src) continue;
      if (src.english !== undefined) el.textContent = tr(src.english);
      else if (src.message !== undefined) el.textContent = notice(src.code, src.message);
    }
  }
  return { SUPPORTED, RTL, DICTIONARY: D, NOTICE_CODES, normalize, choose, recall, remember, setLanguage, tr, notice, text, noticeText, apply, refresh, get language() { return current; } };
});
