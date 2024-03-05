import { reroute } from "./reroute.js";
import { find } from "../utils/find.js";
import { formatErrorMessage } from "../applications/app-errors.js";
import { isInBrowser } from "../utils/runtime-environment.js";

/* We capture navigation event listeners so that we can make sure
 * that application navigation listeners are not called until
 * single-spa has ensured that the correct applications are
 * unmounted and mounted.
 */
const capturedEventListeners = {
  hashchange: [],
  popstate: [],
};

export const routingEventsListeningTo = ["hashchange", "popstate"];

export function navigateToUrl(obj) {
  let url;
  if (typeof obj === "string") {
    url = obj;
  } else if (this && this.href) {
    url = this.href;
  } else if (
    obj &&
    obj.currentTarget &&
    obj.currentTarget.href &&
    obj.preventDefault
  ) {
    url = obj.currentTarget.href;
    obj.preventDefault();
  } else {
    throw Error(
      formatErrorMessage(
        14,
        __DEV__ &&
          `singleSpaNavigate/navigateToUrl must be either called with a string url, with an <a> tag as its context, or with an event whose currentTarget is an <a> tag`
      )
    );
  }

  const current = parseUri(window.location.href);
  const destination = parseUri(url);

  if (url.indexOf("#") === 0) {
    window.location.hash = destination.hash;
  } else if (current.host !== destination.host && destination.host) {
    if (process.env.BABEL_ENV === "test") {
      return { wouldHaveReloadedThePage: true };
    } else {
      window.location.href = url;
    }
  } else if (
    destination.pathname === current.pathname &&
    destination.search === current.search
  ) {
    window.location.hash = destination.hash;
  } else {
    // different path, host, or query params
    window.history.pushState(null, null, url);
  }
}

export function callCapturedEventListeners(eventArguments) {
  if (eventArguments) {
    const eventType = eventArguments[0].type;
    if (routingEventsListeningTo.indexOf(eventType) >= 0) {
      capturedEventListeners[eventType].forEach((listener) => {
        try {
          // The error thrown by application event listener should not break single-spa down.
          // Just like https://github.com/single-spa/single-spa/blob/85f5042dff960e40936f3a5069d56fc9477fac04/src/navigation/reroute.js#L140-L146 did
          listener.apply(this, eventArguments);
        } catch (e) {
          setTimeout(() => {
            throw e;
          });
        }
      });
    }
  }
}

let urlRerouteOnly;

function urlReroute() {
  reroute([], arguments);
}

function patchedUpdateState(updateState, methodName) {
  return function () {
    const urlBefore = window.location.href;
    const result = updateState.apply(this, arguments);
    const urlAfter = window.location.href;

    if (!urlRerouteOnly || urlBefore !== urlAfter) {
      // fire an artificial popstate event so that
      // single-spa applications know about routing that
      // occurs in a different application
      window.dispatchEvent(
        createPopStateEvent(window.history.state, methodName)
      );
    }

    return result;
  };
}

function createPopStateEvent(state, originalMethodName) {
  // https://github.com/single-spa/single-spa/issues/224 and https://github.com/single-spa/single-spa-angular/issues/49
  // We need a popstate event even though the browser doesn't do one by default when you call replaceState, so that
  // all the applications can reroute. We explicitly identify this extraneous event by setting singleSpa=true and
  // singleSpaTrigger=<pushState|replaceState> on the event instance.
  let evt;
  try {
    evt = new PopStateEvent("popstate", { state });
  } catch (err) {
    // IE 11 compatibility https://github.com/single-spa/single-spa/issues/299
    // https://docs.microsoft.com/en-us/openspecs/ie_standards/ms-html5e/bd560f47-b349-4d2c-baa8-f1560fb489dd
    evt = document.createEvent("PopStateEvent");
    evt.initPopStateEvent("popstate", false, false, state);
  }
  evt.singleSpa = true;
  evt.singleSpaTrigger = originalMethodName;
  return evt;
}

export let originalReplaceState = null;

let historyApiIsPatched = false;

/* 
确保单页面应用中的路由行为能够正确地与浏览器的历史API进行交互，并确保单页面应用能够正确地响应导航事件
*/
// We patch the history API so single-spa is notified of all calls to pushState/replaceState.
// We patch addEventListener/removeEventListener so we can capture all popstate/hashchange event listeners,
// and delay calling them until single-spa has finished mounting/unmounting applications
export function patchHistoryApi(opts) {
  /* 确保历史API尚未被修补过。如果已经修补过，则抛出错误。 */
  if (historyApiIsPatched) {
    throw Error(
      formatErrorMessage(
        43,
        __DEV__ &&
          `single-spa: patchHistoryApi() was called after the history api was already patched.`
      )
    );
  }

  // True by default, as a performance optimization that reduces
  // the number of extraneous popstate events
  urlRerouteOnly =
    opts && opts.hasOwnProperty("urlRerouteOnly") ? opts.urlRerouteOnly : true;

  /* 如果历史API尚未被修补过，则设置 historyApiIsPatched 为 true，表示历史API已经被修补。 */
  historyApiIsPatched = true;

  /* 将 window.history.replaceState 的原始实现保存在 originalReplaceState 变量中，以便后续恢复原始实现。 */
  originalReplaceState = window.history.replaceState;

  /* 监听 hashchange 和 popstate 事件，当 URL 发生变化时触发重新路由， 这样 single-spa 就能够处理相应的路由变化 */
  // We will trigger an app change for any routing events.
  window.addEventListener("hashchange", urlReroute);
  window.addEventListener("popstate", urlReroute);

  // Monkeypatch addEventListener so that we can ensure correct timing
  const originalAddEventListener = window.addEventListener;
  const originalRemoveEventListener = window.removeEventListener;

  /* 捕获对 hashchange 和 popstate 事件的监听，确保它们在 single-spa 完成应用的挂载和卸载之后再触发。 */
  window.addEventListener = function (eventName, fn) {
    /* eventName： hashchange，popstate  */
    if (typeof fn === "function") {
      if (
        routingEventsListeningTo.indexOf(eventName) >= 0 &&
        !find(capturedEventListeners[eventName], (listener) => listener === fn)
      ) {
        capturedEventListeners[eventName].push(fn);
        /* 监听到的这两个事件都会被推送到capturedEventListeners这个对象内，暂不执行 */
        /* 
        const capturedEventListeners = {
            hashchange: [],
            popstate: [],
        };
        */
        return;
      }
    }

    return originalAddEventListener.apply(this, arguments);
  };
  window.removeEventListener = function (eventName, listenerFn) {
    if (typeof listenerFn === "function") {
      if (routingEventsListeningTo.indexOf(eventName) >= 0) {
        capturedEventListeners[eventName] = capturedEventListeners[
          eventName
        ].filter((fn) => fn !== listenerFn);
        return;
      }
    }

    return originalRemoveEventListener.apply(this, arguments);
  };
  /* 使用 patchedUpdateState 函数替换原始的方法，以便在调用这两个方法时触发 urlReroute，从而处理路由变化。 */
  window.history.pushState = patchedUpdateState(
    window.history.pushState,
    "pushState"
  );
  window.history.replaceState = patchedUpdateState(
    originalReplaceState,
    "replaceState"
  );
}

// Detect if single-spa has already been loaded on the page.
// If so, warn because this can result in lots of problems, including
// lots of extraneous popstate events and unexpected results for
// apis like getAppNames().
if (isInBrowser) {
  if (window.singleSpaNavigate) {
    console.warn(
      formatErrorMessage(
        41,
        __DEV__ &&
          "single-spa has been loaded twice on the page. This can result in unexpected behavior."
      )
    );
  } else {
    /* For convenience in `onclick` attributes, we expose a global function for navigating to
     * whatever an <a> tag's href is.
     */
    window.singleSpaNavigate = navigateToUrl;
  }
}

function parseUri(str) {
  const anchor = document.createElement("a");
  anchor.href = str;
  return anchor;
}
