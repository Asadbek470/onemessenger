/* ================================================================
   UzMessenger — заставка при входе.
   Подключается одной строкой в самом начале <head> (chat.html, index.html).
   Никаких картинок: логотип UM «рисуется» линиями на глазах, вокруг него
   расходятся круги, потом проявляется название. Всё внимание — на мессенджер.

   Показывается при входе и не повторяется чаще, чем раз в 8 секунд
   (чтобы не мигать дважды при переходе со страницы входа в чаты).
   Нажми на заставку — она закроется сразу.
   ================================================================ */
(function () {
  try {
    var last = Number(sessionStorage.getItem("omSplashAt") || 0);
    if (Date.now() - last < 8000) return;
    sessionStorage.setItem("omSplashAt", String(Date.now()));
  } catch (e) {}

  var reduce = false;
  try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  var css = [
    "#omSplash{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;overflow:hidden;",
    "background:radial-gradient(900px 700px at 50% 42%,#15335a 0%,#0a1626 55%,#050a13 100%);",
    "font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#eaf2ff;",
    "transition:opacity .55s ease,transform .55s ease,filter .55s ease}",
    "#omSplash.out{opacity:0;transform:scale(1.06);filter:blur(6px);pointer-events:none}",

    /* мягкое северное сияние на фоне */
    "#omSplash .blob{position:absolute;width:70vmax;height:70vmax;border-radius:50%;filter:blur(90px);opacity:.55}",
    "#omSplash .b1{top:-25vmax;left:-20vmax;background:radial-gradient(circle,rgba(42,157,244,.75),transparent 65%);animation:omDrift1 6s ease-in-out infinite alternate}",
    "#omSplash .b2{bottom:-30vmax;right:-20vmax;background:radial-gradient(circle,rgba(140,80,255,.65),transparent 65%);animation:omDrift2 6s ease-in-out infinite alternate}",
    "@keyframes omDrift1{to{transform:translate(9vmax,7vmax) scale(1.12)}}",
    "@keyframes omDrift2{to{transform:translate(-8vmax,-7vmax) scale(1.1)}}",

    "#omSplash .stage{position:relative;display:flex;flex-direction:column;align-items:center;gap:22px;padding:24px}",
    "#omSplash .logowrap{position:relative;width:132px;height:132px;display:grid;place-items:center}",

    /* круги, расходящиеся от логотипа */
    "#omSplash .ring{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(96,176,255,.55);opacity:0;animation:omRing 1.5s ease-out forwards}",
    "#omSplash .r1{animation-delay:1.05s}#omSplash .r2{animation-delay:1.3s}#omSplash .r3{animation-delay:1.55s}",
    "@keyframes omRing{0%{transform:scale(.75);opacity:.85}100%{transform:scale(3.1);opacity:0}}",

    "#omSplash svg{position:relative;width:132px;height:132px;overflow:visible;",
    "filter:drop-shadow(0 18px 44px rgba(42,157,244,.5));",
    "animation:omTile .8s cubic-bezier(.2,1.35,.3,1) both}",
    "@keyframes omTile{0%{transform:scale(.55) rotate(-9deg);opacity:0;filter:blur(10px) drop-shadow(0 0 0 rgba(42,157,244,0))}",
    "100%{transform:scale(1) rotate(0);opacity:1}}",

    /* буквы U и M вырисовываются линией */
    "#omSplash .draw{fill:none;stroke:#fff;stroke-width:14;stroke-linecap:round;stroke-linejoin:round;",
    "stroke-dasharray:100;stroke-dashoffset:100;animation:omDraw .75s cubic-bezier(.5,0,.2,1) forwards}",
    "#omSplash .dU{animation-delay:.3s}#omSplash .dM{animation-delay:.6s}",
    "@keyframes omDraw{to{stroke-dashoffset:0}}",

    /* блик, пробегающий по значку */
    "#omSplash .shine{transform:translateX(-260px);animation:omShine .9s ease-in-out 1.15s forwards}",
    "@keyframes omShine{to{transform:translateX(260px)}}",

    /* название по буквам */
    "#omSplash .word{display:flex;font-size:30px;font-weight:800;letter-spacing:.5px}",
    "#omSplash .word span{display:inline-block;opacity:0;transform:translateY(14px);filter:blur(6px);",
    "animation:omLetter .55s cubic-bezier(.2,.9,.3,1) forwards}",
    "#omSplash .word .sp{width:.32em}",
    "@keyframes omLetter{to{opacity:1;transform:none;filter:none}}",

    "#omSplash .tag{margin-top:-12px;font-size:14px;color:#8fb2dd;opacity:0;animation:omFade .7s ease 1.55s forwards}",
    "@keyframes omFade{to{opacity:1}}",

    /* тонкая полоска загрузки */
    "#omSplash .bar{width:120px;height:3px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden;opacity:0;animation:omFade .4s ease 1s forwards}",
    "#omSplash .bar i{display:block;height:100%;width:0;border-radius:3px;background:linear-gradient(90deg,#2a9df4,#8b5cff);animation:omBar 1.3s cubic-bezier(.4,0,.2,1) 1.05s forwards}",
    "@keyframes omBar{to{width:100%}}",

    "@media (prefers-reduced-motion:reduce){",
    "#omSplash *{animation:none!important}",
    "#omSplash .draw{stroke-dashoffset:0}",
    "#omSplash .word span,#omSplash .tag,#omSplash .bar{opacity:1;transform:none;filter:none}",
    "#omSplash .bar i{width:100%}#omSplash .ring,#omSplash .shine{display:none}}"
  ].join("");

  var word = "UzMessenger".split("").map(function (ch, i) {
    if (ch === " ") return '<span class="sp"></span>';
    return '<span style="animation-delay:' + (1.0 + i * 0.045).toFixed(3) + 's">' + ch + "</span>";
  }).join("");

  var html =
    '<div class="blob b1"></div><div class="blob b2"></div>' +
    '<div class="stage">' +
      '<div class="logowrap">' +
        '<div class="ring r1"></div><div class="ring r2"></div><div class="ring r3"></div>' +
        '<svg viewBox="0 0 200 200" aria-hidden="true">' +
          '<defs>' +
            '<linearGradient id="omg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a9df4"/><stop offset="1" stop-color="#6a5cff"/></linearGradient>' +
            '<linearGradient id="oms" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
            '<clipPath id="omc"><rect width="200" height="200" rx="46"/></clipPath>' +
          '</defs>' +
          '<rect width="200" height="200" rx="46" fill="url(#omg)"/>' +
          '<ellipse cx="100" cy="30" rx="70" ry="34" fill="#fff" opacity=".1"/>' +
          '<path class="draw dU" pathLength="100" d="M35 67 V109 Q35 133 59 133 Q83 133 83 109 V67"/>' +
          '<path class="draw dM" pathLength="100" d="M112 133 V67 L140 111.5 L168 67 V133"/>' +
          '<g clip-path="url(#omc)"><rect class="shine" x="0" y="-20" width="70" height="240" fill="url(#oms)" transform="skewX(-18)"/></g>' +
        '</svg>' +
      '</div>' +
      '<div class="word">' + word + '</div>' +
      '<div class="tag">Общение без номера телефона</div>' +
      '<div class="bar"><i></i></div>' +
    '</div>';

  var style = document.createElement("style");
  style.textContent = css;
  var el = document.createElement("div");
  el.id = "omSplash";
  el.innerHTML = html;
  document.documentElement.appendChild(style);
  document.documentElement.appendChild(el);

  var closed = false;
  function hide() {
    if (closed) return;
    closed = true;
    el.classList.add("out");
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (style.parentNode) style.parentNode.removeChild(style);
    }, 650);
  }
  el.addEventListener("click", hide);
  setTimeout(hide, reduce ? 700 : 2700);
})();
