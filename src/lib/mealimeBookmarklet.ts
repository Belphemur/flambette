/**
 * The Mealime favourites bookmarklet (ADR-0058).
 *
 * A one-shot migration tool: Mealime shuts down 2026-10-21 and there is no
 * official export. The app itself can never call `mealime.com` (offline-first,
 * e2e-enforced), so this snippet runs IN the user's browser on
 * my.mealime.com — dropped there as a bookmarklet from the Settings tab —
 * reads the session cookie, calls the same RPC Mealime's own web app uses,
 * and puts a small JSON payload on the clipboard. The paste box on
 * `/settings` is the only ingress into this app: no token, cookie or
 * password ever transits Flambette.
 *
 * It holds no secrets: `client_id` is the public web-client id from
 * Mealime's own bundle, and the snippet only reads the COOKIE NAME — never
 * a value we keep.
 */
export const MEALIME_BOOKMARKLET_SOURCE = `(function(){
  var m=document.cookie.match(/(?:^|;\\s*)auth_token=([^;]+)/);
  if(!m){alert("Flambette: you are not logged in to Mealime - no auth token found.");return;}
  fetch("https://api.mealime.com/api/v2/get_builder_data",{
    method:"POST",
    headers:{"Authorization":"Token token="+m[1],"Content-Type":"application/json","Accept":"application/json"},
    body:JSON.stringify({source:"my-web",client_id:"f4590t00mx4"})
  }).then(function(r){
    if(!r.ok)throw new Error("Mealime API returned "+r.status);
    return r.json();
  }).then(function(data){
    var favs=(data&&data.favourites)||[];
    var out=[];
    for(var i=0;i<favs.length;i++){
      var t=/\\/uploads\\/recipe\\/thumbnail\\/(\\d+)\\//.exec(favs[i].image_url||"");
      if(t)out.push({recipe_id:Number(t[1]),name:favs[i].name||""});
    }
    if(out.length===0){alert("Flambette: no favourites found in your Mealime account.");return;}
    var payload=JSON.stringify({source:"flambette-bookmarklet",generatedAt:new Date().toISOString(),favourites:out});
    navigator.clipboard.writeText(payload).then(function(){
      alert("Copied "+out.length+" favourites - paste them into Flambette (Settings, Import from Mealime).");
    },function(){
      alert("Flambette: could not copy to the clipboard.");
    });
  }).catch(function(e){
    alert("Flambette: "+(e&&e.message?e.message:"something went wrong."));
  });
})();`

/**
 * The bookmarklet as an `href` value: the source, URL-encoded so it can sit
 * in an anchor's `javascript:` href and survive being dragged to a
 * bookmarks bar.
 */
export function mealimeBookmarkletHref(): string {
  return 'javascript:' + encodeURIComponent(MEALIME_BOOKMARKLET_SOURCE)
}
