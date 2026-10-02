/* ================================================================
   Zumo — заставка при входе.
   Подключается одной строкой в самом начале <head> (chat.html, index.html).

   Сценарий: тёмный фон с «дышащим» сиянием и плывущими частицами →
   плашка логотипа влетает в 3D с лёгким доворотом → две половинки буквы Z
   съезжаются с двух сторон и «стыкуются» со вспышкой и ударной волной →
   название открывается широким диагональным «стиранием» (wipe) →
   полоска загрузки с бегущим бликом. Всё на CSS-анимациях и SVG,
   без картинок.

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

    /* дышащее сияние фона */
    "#omSplash .blob{position:absolute;width:70vmax;height:70vmax;border-radius:50%;filter:blur(90px);opacity:.5}",
    "#omSplash .b1{top:-25vmax;left:-20vmax;background:radial-gradient(circle,rgba(42,157,244,.75),transparent 65%);animation:omDrift1 7s ease-in-out infinite alternate}",
    "#omSplash .b2{bottom:-30vmax;right:-20vmax;background:radial-gradient(circle,rgba(140,80,255,.65),transparent 65%);animation:omDrift2 7s ease-in-out infinite alternate}",
    "#omSplash .b3{top:50%;left:50%;width:55vmax;height:55vmax;margin:-27.5vmax 0 0 -27.5vmax;",
    "background:radial-gradient(circle,rgba(70,220,255,.28),transparent 70%);animation:omPulseBg 4.2s ease-in-out infinite}",
    "@keyframes omDrift1{to{transform:translate(9vmax,7vmax) scale(1.12)}}",
    "@keyframes omDrift2{to{transform:translate(-8vmax,-7vmax) scale(1.1)}}",
    "@keyframes omPulseBg{0%,100%{opacity:.35;transform:scale(.9)}50%{opacity:.7;transform:scale(1.08)}}",

    /* частицы, всплывающие вверх — как отправленные сообщения */
    "#omSplash .dot{position:absolute;bottom:-6vh;width:7px;height:7px;border-radius:50%;",
    "background:linear-gradient(180deg,#8fd4ff,#6a8cff);opacity:0;animation:omFloat linear infinite}",
    "@keyframes omFloat{0%{transform:translateY(0) scale(.6);opacity:0}",
    "8%{opacity:.8}70%{opacity:.5}100%{transform:translateY(-112vh) scale(1.1);opacity:0}}",

    "#omSplash .stage{position:relative;display:flex;flex-direction:column;align-items:center;gap:20px;padding:24px;perspective:900px}",
    "#omSplash .logowrap{position:relative;width:132px;height:132px;display:grid;place-items:center;",
    "animation:omSettle .5s ease .78s both}",
    "@keyframes omSettle{0%{transform:scale(1)}35%{transform:scale(1.12)}100%{transform:scale(1)}}",

    /* единая ударная волна в момент стыковки букв */
    "#omSplash .shock{position:absolute;inset:0;border-radius:50%;border:2.5px solid rgba(140,200,255,.8);",
    "opacity:0;animation:omShock .7s cubic-bezier(.15,.8,.3,1) .78s forwards}",
    "@keyframes omShock{0%{transform:scale(.6);opacity:.95;border-width:3px}100%{transform:scale(2.5);opacity:0;border-width:.5px}}",

    /* белая вспышка по центру значка */
    "#omSplash .flash{position:absolute;inset:0;border-radius:46px;background:radial-gradient(circle,#fff,transparent 70%);",
    "opacity:0;mix-blend-mode:screen;animation:omFlash .55s ease .78s forwards}",
    "@keyframes omFlash{0%{opacity:0}18%{opacity:.85}100%{opacity:0}}",

    /* плашка влетает в 3D с доворотом */
    "#omSplash .badge{position:relative;width:132px;height:132px;overflow:visible;",
    "filter:drop-shadow(0 18px 44px rgba(42,157,244,.5));transform-style:preserve-3d;",
    "animation:omTileIn .65s cubic-bezier(.2,1.2,.3,1) both}",
    "@keyframes omTileIn{0%{transform:rotateY(-110deg) scale(.4);opacity:0;filter:blur(10px)}",
    "60%{filter:blur(0)}100%{transform:rotateY(0) scale(1);opacity:1}}",

    /* половинки логотипа съезжаются с разных сторон */
    "#omSplash .uHalf,#omSplash .mHalf{transform-box:fill-box;transform-origin:50% 50%;opacity:0;",
    "animation:omSlide .55s cubic-bezier(.17,.84,.3,1.15) .32s forwards}",
    "#omSplash .uHalf{transform:translateX(-46px)}",
    "#omSplash .mHalf{transform:translateX(46px);animation-delay:.4s}",
    "@keyframes omSlide{0%{opacity:0}100%{transform:translateX(0);opacity:1}}",

    /* блик, пробегающий по значку после стыковки */
    "#omSplash .shine{transform:translateX(-260px);animation:omShine .9s ease-in-out 1s forwards}",
    "@keyframes omShine{to{transform:translateX(260px)}}",

    /* название открывается диагональным стиранием */
    "#omSplash .word{font-size:30px;font-weight:800;letter-spacing:.5px;position:relative;",
    "clip-path:polygon(0 0,0 0,0 100%,0 100%);animation:omWipe .75s cubic-bezier(.22,1,.36,1) 1.08s forwards}",
    "@keyframes omWipe{to{clip-path:polygon(0 0,100% 0,100% 100%,0 100%)}}",

    "#omSplash .tag{margin-top:-12px;font-size:14px;color:#8fb2dd;opacity:0;transform:translateY(8px);",
    "animation:omTagIn .6s ease 1.55s forwards}",
    "@keyframes omTagIn{to{opacity:1;transform:none}}",

    /* полоска загрузки с бегущим бликом */
    "#omSplash .bar{width:120px;height:3px;border-radius:3px;background:rgba(255,255,255,.12);",
    "overflow:hidden;opacity:0;position:relative;animation:omTagIn .4s ease 1.15s forwards}",
    "#omSplash .bar i{display:block;height:100%;width:0;border-radius:3px;",
    "background:linear-gradient(90deg,#2a9df4,#8b5cff);animation:omBar 1.25s cubic-bezier(.4,0,.2,1) 1.2s forwards}",
    "#omSplash .bar b{position:absolute;top:0;left:0;height:100%;width:26px;",
    "background:linear-gradient(90deg,transparent,rgba(255,255,255,.75),transparent);",
    "transform:translateX(-30px);animation:omBarShine 1.25s cubic-bezier(.4,0,.2,1) 1.2s forwards}",
    "@keyframes omBar{to{width:100%}}",
    "@keyframes omBarShine{to{transform:translateX(146px)}}",

    "@media (prefers-reduced-motion:reduce){",
    "#omSplash *{animation:none!important}",
    "#omSplash .badge{opacity:1;transform:none;filter:none}",
    "#omSplash .uHalf,#omSplash .mHalf{opacity:1;transform:none}",
    "#omSplash .word{clip-path:none}",
    "#omSplash .tag,#omSplash .bar{opacity:1;transform:none}",
    "#omSplash .bar i{width:100%}",
    "#omSplash .shock,#omSplash .flash,#omSplash .shine,#omSplash .dot,#omSplash .b3,#omSplash .bar b{display:none}}"
  ].join("");

  var dots = "";
  var dotCfg = [
    [6, 0.0, 6.4], [17, 1.1, 7.2], [29, 2.3, 6.8], [41, 0.6, 7.6],
    [55, 1.8, 6.6], [67, 0.3, 7.0], [79, 2.6, 7.4], [91, 1.4, 6.9]
  ];
  for (var i = 0; i < dotCfg.length; i++) {
    var c = dotCfg[i];
    dots += '<div class="dot" style="left:' + c[0] + '%;animation-delay:' + c[1] + 's;animation-duration:' + c[2] + 's"></div>';
  }

  var word = "Zumo";

  var html =
    '<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>' +
    dots +
    '<div class="stage">' +
      '<div class="logowrap">' +
        '<div class="shock"></div>' +
        '<div class="badge">' +
          '<svg viewBox="0 0 200 200" width="132" height="132" aria-hidden="true">' +
            '<defs>' +
              '<linearGradient id="omg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a9df4"/><stop offset="1" stop-color="#6a5cff"/></linearGradient>' +
              '<linearGradient id="oms" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
              '<clipPath id="omc"><rect width="200" height="200" rx="46"/></clipPath>' +
            '</defs>' +
            '<rect width="200" height="200" rx="46" fill="url(#omg)"/>' +
            '<ellipse cx="100" cy="30" rx="70" ry="34" fill="#fff" opacity=".1" clip-path="url(#omc)"/>' +
            '<g class="uHalf"><path fill="none" stroke="#fff" stroke-width="17" stroke-linecap="round" stroke-linejoin="round" d="M66 62 H134 L100 100"/></g>' +
            '<g class="mHalf"><path fill="none" stroke="#fff" stroke-width="17" stroke-linecap="round" stroke-linejoin="round" d="M100 100 L66 138 H134"/></g>' +
            '<g clip-path="url(#omc)"><rect class="shine" x="0" y="-20" width="70" height="240" fill="url(#oms)" transform="skewX(-18)"/></g>' +
          '</svg>' +
          '<div class="flash"></div>' +
        '</div>' +
      '</div>' +
      '<div class="word">' + word + '</div>' +
      '<div class="tag">Общение без номера телефона</div>' +
      '<div class="bar"><i></i><b></b></div>' +
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
  setTimeout(hide, reduce ? 700 : 2750);
})();
