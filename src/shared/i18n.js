/*
 * Every user-facing string in the app, in Persian and English. Shared by the
 * main process (require) and the renderers (window.GuyaI18n).
 *
 * Keys are grouped: `error.*` and `status.*` come back from the main process,
 * `ui.*` belong to the panel markup, `prompt.*` feed the Gemini instruction.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GuyaI18n = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LANGUAGES = [
    { code: 'auto', fa: 'تشخیص خودکار', en: 'Auto detect' },
    { code: 'fa', fa: 'فارسی', en: 'Persian' },
    { code: 'en', fa: 'انگلیسی', en: 'English' },
    { code: 'ar', fa: 'عربی', en: 'Arabic' },
    { code: 'tr', fa: 'ترکی', en: 'Turkish' },
    { code: 'de', fa: 'آلمانی', en: 'German' },
    { code: 'fr', fa: 'فرانسه', en: 'French' },
    { code: 'es', fa: 'اسپانیایی', en: 'Spanish' },
    { code: 'ru', fa: 'روسی', en: 'Russian' },
    { code: 'zh', fa: 'چینی', en: 'Chinese' },
    { code: 'hi', fa: 'هندی', en: 'Hindi' }
  ];

  /* The instruction text older builds shipped, in the field the user owns. It lives
   * here for the one reason non-Latin text is allowed in this file: it is text in
   * two languages. The migration in the store clears it, so an install that still
   * carries one of these ends up with an empty field. The model's own instructions,
   * which are not user-visible and not translated, are in `prompt.js`. */
  var LEGACY_PROMPTS = {
    fa:
      'تو یک موتور تبدیل گفتار به متن هستی. هر چیزی که در صدا شنیده می‌شود را دقیق و کامل به متن تبدیل کن. ' +
      'فقط متن نهایی را بنویس؛ بدون توضیح، بدون عنوان و بدون برچسب گوینده. اگر گفتار قابل تشخیصی در صدا نیست، خروجی را خالی بگذار.',
    en:
      'You are a speech-to-text engine. Transcribe everything spoken in the recording verbatim. ' +
      'Output only the transcript — no commentary, no headings, no speaker labels. If there is no intelligible speech, output nothing.'
  };

  var MESSAGES = {
    /* ---- main process: errors ---- */
    'error.noKey': { fa: 'کلید API جمنای ثبت نشده است.', en: 'No Gemini API key yet.' },
    'error.micDenied': { fa: 'دسترسی میکروفون برای Guya بسته است.', en: 'Microphone access for Guya is turned off.' },
    'error.micFailed': { fa: 'راه‌اندازی میکروفون ناموفق بود.', en: 'The microphone could not be started.' },
    'error.tooShort': { fa: 'صدا خیلی کوتاه بود، دوباره تلاش کنید.', en: 'That was too short, try again.' },
    'error.unexpected': { fa: 'خطای غیرمنتظره', en: 'Unexpected error' },
    'error.noModel': { fa: 'مدلی انتخاب نشده است.', en: 'No model selected.' },
    'error.timeout': { fa: 'زمان درخواست به پایان رسید.', en: 'The request timed out.' },
    'error.offline': { fa: 'اتصال به سرور برقرار نشد.', en: 'Could not reach the server.' },
    'error.badKey': { fa: 'کلید API معتبر نیست.', en: 'That API key is not valid.' },
    'error.badRequest': { fa: 'درخواست نامعتبر بود.', en: 'The request was rejected.' },
    'error.forbidden': { fa: 'دسترسی رد شد؛ مطمئن شوید کلید API فعال است.', en: 'Access denied — check that the API key is active.' },
    'error.modelMissing': { fa: 'این مدل برای کلید شما در دسترس نیست.', en: 'This model is not available for your key.' },
    'error.quota': { fa: 'سهمیه یا محدودیت نرخ درخواست پر شده است.', en: 'Rate limit or quota reached.' },
    'error.server': { fa: 'خطای موقت سرویس گوگل، دوباره تلاش کنید.', en: 'Temporary Google service error, try again.' },
    'error.http': { fa: 'خطای HTTP {status}', en: 'HTTP error {status}' },
    'error.noSpeech': { fa: 'متنی از صدا تشخیص داده نشد.', en: 'No speech detected in that audio.' },
    'error.blocked': { fa: 'درخواست توسط فیلتر ایمنی رد شد.', en: 'The request was blocked by a safety filter.' },
    'error.filtered': { fa: 'پاسخ توسط فیلتر ایمنی حذف شد.', en: 'The reply was removed by a safety filter.' },
    'error.emptyReply': { fa: 'پاسخی از مدل دریافت نشد.', en: 'The model returned nothing.' },
    'error.modelUnsupported': {
      fa: 'این مدل برای رونویسی ساخته نشده است؛ مدل دیگری انتخاب کنید.',
      en: 'That model cannot do transcription. Choose another one.'
    },
    'error.truncated': { fa: 'متن ناقص ماند (صدا طولانی بود).', en: 'The transcript was cut off (audio too long).' },
    'error.pasteFailed': { fa: 'جای‌گذاری خودکار انجام نشد.', en: 'Automatic paste failed.' },
    'error.pastePermission': {
      fa: 'برای جای‌گذاری خودکار، در تنظیمات سیستم › حریم خصوصی و امنیت › دسترس‌پذیری به Guya اجازه بدهید.',
      en: 'To paste automatically, allow Guya under System Settings › Privacy & Security › Accessibility.'
    },
    'error.unsupportedPlatform': { fa: 'این سیستم‌عامل پشتیبانی نمی‌شود.', en: 'This platform is not supported.' },
    'error.shortcutTaken': {
      fa: 'این ترکیب کلید در دسترس نیست (برنامه دیگری آن را گرفته است).',
      en: 'That shortcut is taken by another app.'
    },
    'error.shortcutInvalid': { fa: 'این ترکیب کلید معتبر نیست.', en: 'That shortcut is not valid.' },
    'error.loginItemPackagedOnly': { fa: 'این گزینه فقط در نسخه نصب‌شده کار می‌کند.', en: 'This option only works in the installed app.' },
    'error.micNotFound': { fa: 'میکروفونی پیدا نشد.', en: 'No microphone found.' },
    'error.micBusy': { fa: 'میکروفون در اختیار برنامه دیگری است.', en: 'Another app is using the microphone.' },

    /* ---- panel UI ---- */
    'ui.title': { fa: 'گویا', en: 'Guya' },
    'ui.engineName': { fa: 'Gemini', en: 'Gemini' },
    'ui.apiKeyExample': { fa: 'AIza…', en: 'AIza…' },
    'ui.settings': { fa: 'تنظیمات', en: 'Settings' },
    'ui.back': { fa: 'بازگشت', en: 'Back' },
    'ui.customModel': { fa: 'سفارشی…', en: 'Custom…' },
    'ui.tapToDictate': { fa: 'برای دیکته بزنید', en: 'Tap to dictate' },
    'ui.copyTranscript': { fa: 'کپی متن', en: 'Copy transcript' },
    'ui.dictation': { fa: 'دیکته', en: 'Dictation' },
    'ui.output': { fa: 'خروجی', en: 'Output' },
    'ui.about': { fa: 'درباره', en: 'About' },
    'ui.interfaceLanguage': { fa: 'زبان برنامه', en: 'Interface language' },
    'ui.interfaceFa': { fa: 'فارسی', en: 'Persian' },
    'ui.interfaceEn': { fa: 'انگلیسی', en: 'English' },
    'ui.version': { fa: 'نسخه', en: 'Version' },
    'ui.processing': { fa: 'پردازش', en: 'Processing' },
    'ui.processingValue': { fa: 'Gemini، با کلید خودتان', en: 'Gemini, with your key' },
    'ui.apiKey': { fa: 'کلید API', en: 'API key' },
    'ui.model': { fa: 'مدل', en: 'Model' },
    'ui.spokenLanguage': { fa: 'زبان گفتار', en: 'Spoken language' },
    'ui.prompt': { fa: 'پرامپت سیستم', en: 'System prompt' },
    'ui.shortcut': { fa: 'شورت‌کات ضبط', en: 'Recording shortcut' },
    'ui.copy': { fa: 'کپی در کلیپ‌بورد', en: 'Copy to clipboard' },
    'ui.paste': { fa: 'جای‌گذاری خودکار', en: 'Paste automatically' },
    'ui.launchAtLogin': { fa: 'اجرا هنگام ورود', en: 'Launch at login' },
    'ui.lastTranscript': { fa: 'آخرین متن', en: 'Last transcript' },
    'ui.languageName': { fa: 'فارسی', en: 'English' },
    'ui.refreshModels': { fa: 'دریافت مدل‌ها', en: 'Refresh models' },
    'ui.resetPrompt': { fa: 'بازگشت به پرامپت پیش‌فرض', en: 'Reset to the default prompt' },
    'ui.showKey': { fa: 'نمایش کلید', en: 'Show key' },
    'ui.hideKey': { fa: 'پنهان کردن کلید', en: 'Hide key' },
    'ui.emptyTranscript': { fa: 'هنوز متنی نیست', en: 'Nothing yet' },
    'ui.pressKeys': { fa: 'کلیدها را بزنید…', en: 'Press keys…' },
    'ui.escToCancel': { fa: 'Esc برای لغو', en: 'Esc to cancel' },
    'ui.shortcutNeedsModifier': { fa: 'حداقل یک کلید کنترلی لازم است.', en: 'Use at least one modifier key.' },
    'ui.shortcutUnsupported': { fa: 'این کلید پشتیبانی نمی‌شود.', en: 'That key is not supported.' },
    'ui.shortcutReserved': { fa: 'این ترکیب توسط سیستم استفاده می‌شود.', en: 'The system already uses that combination.' },

    /* ---- panel actions and status ---- */
    'action.test': { fa: 'تست کلید', en: 'Test key' },
    'action.record': { fa: 'شروع ضبط', en: 'Start recording' },
    'action.stop': { fa: 'توقف', en: 'Stop' },
    'status.ready': { fa: 'آماده', en: 'Ready' },
    'status.starting': { fa: 'آماده‌سازی میکروفون…', en: 'Starting microphone…' },
    'status.listening': { fa: 'در حال شنیدن…', en: 'Listening…' },
    'status.retrying': { fa: 'تلاش دوباره ({attempt} از {total})…', en: 'Trying again ({attempt} of {total})…' },
    'ui.attempts': { fa: 'تعداد تلاش', en: 'Attempts' },
    'ui.attemptsValue': { fa: '{count} بار', en: '{count}' },
    'ui.silence': { fa: 'توقف خودکار روی سکوت', en: 'Stop after silence' },
    'ui.silenceOff': { fa: 'خاموش', en: 'Off' },
    'ui.secondsShort': { fa: '{count} ثانیه', en: '{count} seconds' },
    'status.recording': { fa: 'در حال ضبط…', en: 'Recording…' },
    'status.transcribing': { fa: 'در حال تبدیل…', en: 'Transcribing…' },
    'status.done': { fa: 'متن آماده شد.', en: 'Transcript ready.' },
    'status.doneCopied': { fa: 'متن آماده و کپی شد.', en: 'Transcript ready and copied.' },
    'status.savedPasteHint': { fa: 'ذخیره شد — اولین جای‌گذاری اجازه دسترس‌پذیری می‌خواهد.', en: 'Saved — the first paste asks for Accessibility permission.' },
    'status.checkingKey': { fa: 'بررسی کلید…', en: 'Checking the key…' },
    'status.keyOk': { fa: 'کلید سالم است.', en: 'The key works.' },
    'status.loadingModels': { fa: 'دریافت مدل‌ها…', en: 'Fetching models…' },
    'status.modelsLoaded': { fa: '{count} مدل در دسترس', en: '{count} models available' },
    'status.modelNotListed': { fa: 'این مدل در فهرست کلید شما نیست.', en: 'This model is not in your key’s list.' },
    'status.saveToApply': { fa: 'برای اعمال، «ذخیره» را بزنید.', en: 'Press Save to apply.' },
    'status.copied': { fa: 'کپی شد.', en: 'Copied.' },
    'settings.engineFootnote': {
      fa: 'صدا با کلید خودتان به API جمنای فرستاده و متن برگردانده می‌شود. Guya سرور خودش را ندارد.',
      en: 'Audio is uploaded to the Gemini API and the transcript is returned. Guya has no server of its own.'
    },
    'settings.promptFootnote': {
      fa: 'همین متن با هر ضبط به مدل فرستاده می‌شود. انگلیسی است و می‌توانید عوضش کنید.',
      en: 'This text is sent with every recording. It is in English, and yours to change.'
    },
    'settings.pasteFootnote': {
      fa: 'متن را در برنامه‌ای که باز است تایپ می‌کند.',
      en: 'Types the transcript into whichever app has focus.'
    },
    'settings.pasteNeedsPermission': {
      fa: 'مک برای تایپ در برنامه‌های دیگر اجازه‌ی «دسترس‌پذیری» می‌خواهد. تا وقتی این اجازه را نداده‌اید، این گزینه روشن نمی‌ماند.',
      en: 'macOS requires Accessibility permission before an app can type into another app. Until it is granted, this stays off.'
    },
    'ui.openSystemSettings': { fa: 'باز کردن تنظیمات سیستم', en: 'Open System Settings' },
    'settings.pasteNeedsTool': {
      fa: 'برای تایپ خودکار در لینوکس یکی از این ابزارها را نصب کنید: xdotool (روی X11) یا ydotool / wtype (روی Wayland).',
      en: 'To type automatically on Linux, install one of: xdotool (X11), ydotool or wtype (Wayland).'
    },
    'error.pasteNeedsTool': {
      fa: 'ابزار تایپ خودکار روی این سیستم نصب نیست (xdotool یا ydotool/wtype).',
      en: 'No automatic-paste helper is installed (xdotool, or ydotool/wtype).'
    },
    'ui.askMacos': { fa: 'اجازه گرفتن از مک', en: 'Ask macOS' },
    'ui.pasteGranted': { fa: 'اجازه داده شد', en: 'Permission granted' },
    'status.armed': { fa: 'در انتظار «{word}»…', en: 'Waiting for “{word}”…' },
    'status.silenceStop': { fa: 'سکوت — ضبط خودکار متوقف شد.', en: 'Silence — recording stopped automatically.' }
  };

  function normalizeLanguage(language) {
    return language === 'en' ? 'en' : 'fa';
  }

  /* t('en', 'error.http', { status: 404 }) */
  function t(language, key, vars) {
    var lang = normalizeLanguage(language);
    var entry = MESSAGES[key];
    var text = entry ? entry[lang] || entry.fa : key;
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        text = text.split('{' + name + '}').join(String(vars[name]));
      });
    }
    return text;
  }

  function languageLabel(code, uiLanguage) {
    var lang = normalizeLanguage(uiLanguage);
    var found = LANGUAGES.filter(function (item) {
      return item.code === code;
    })[0];
    return found ? found[lang] : code;
  }

  return {
    LANGUAGES: LANGUAGES,
    LEGACY_PROMPTS: LEGACY_PROMPTS,
    MESSAGES: MESSAGES,
    t: t,
    languageLabel: languageLabel,
    normalizeLanguage: normalizeLanguage
  };
});
