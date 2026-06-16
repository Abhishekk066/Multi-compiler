(function () {
  function MemStorage() {
    var d = {};
    return {
      getItem: function (k) {
        return d.hasOwnProperty(k) ? d[k] : null;
      },
      setItem: function (k, v) {
        d[k] = String(v);
      },
      removeItem: function (k) {
        delete d[k];
      },
      clear: function () {
        d = {};
      },
      key: function (i) {
        return Object.keys(d)[i] || null;
      },
      get length() {
        return Object.keys(d).length;
      },
    };
  }

  ["localStorage", "sessionStorage"].forEach(function (name) {
    var ok = false;
    try {
      window[name];
      ok = true;
    } catch (e) {}
    if (ok) return;

    var mem = MemStorage();

    // Strategy 1: own accessor on window
    try {
      Object.defineProperty(window, name, {
        get: function () {
          return mem;
        },
        set: function () {},
        configurable: true,
        enumerable: true,
      });
      return;
    } catch (e) {}

    try {
      Object.defineProperty(Window.prototype, name, {
        get: function () {
          return mem;
        },
        set: function () {},
        configurable: true,
        enumerable: true,
      });
      return;
    } catch (e) {}

    try {
      window[name] = mem;
    } catch (e) {}
  });
})();
