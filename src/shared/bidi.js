/*
 * Text direction for content the user spoke.
 *
 * The interface has its own direction, but a transcript does not belong to the
 * interface: a Persian sentence must read right-to-left even when the app is in
 * English, and the other way round. `dir="auto"` is not enough — it looks only at
 * the first strong character, so an English word followed by a Persian sentence
 * would come out left-to-right.
 * This counts the strong characters of the whole paragraph and takes the
 * majority, which is what a reader's eye does.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GuyaBidi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RTL_SCRIPT = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0780-\u07BF\u0800-\u085F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
  var LTR_SCRIPT = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;

  /* Letters only: digits and punctuation carry no direction, and a paragraph of
   * numbers should keep the direction of the interface around it. */
  function directionOf(text, fallback) {
    var rtl = 0;
    var ltr = 0;
    var value = String(text || '');
    for (var i = 0; i < value.length; i++) {
      var character = value[i];
      if (RTL_SCRIPT.test(character)) rtl++;
      else if (LTR_SCRIPT.test(character)) ltr++;
    }
    if (rtl === 0 && ltr === 0) return fallback === 'rtl' ? 'rtl' : 'ltr';
    return rtl >= ltr ? 'rtl' : 'ltr';
  }

  /* Paragraphs as the model returned them: the breaks are meaningful, and each
   * one gets its own direction. */
  function blocksOf(text) {
    return String(text || '')
      .split(/\n+/)
      .map(function (line) {
        return line.trim();
      })
      .filter(function (line) {
        return line.length > 0;
      });
  }

  return { directionOf: directionOf, blocksOf: blocksOf };
});
