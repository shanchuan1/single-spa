import { reroute } from "./navigation/reroute.js";
import { patchHistoryApi } from "./navigation/navigation-events.js";
import { isInBrowser } from "./utils/runtime-environment.js";

let started = false;



/* 
一、拦截改造History的API（主要是监听hashchange popstate）
   1. 
二、路由重导
*/
export function start(opts) {
  started = true;
  if (isInBrowser) {
    patchHistoryApi(opts);
    reroute();
  }
}

export function isStarted() {
  return started;
}
