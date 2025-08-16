import { getUser as getUserImpl } from "./utils.ts";

async function getUser(
  id,
  clientId,
  accessToken,
) {
  return await getUserImpl(id, clientId, accessToken);
}

function redirect(res, clientId, redirectUri, scopes) {
  res.redirect(
    `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${
      encodeURIComponent(scopes.join(" "))
    }`,
  );
}

export function auth(res, clientId, redirectUri, scopes) {
  redirect(res, clientId, redirectUri, scopes);
}

export async function authCallback(c) {
  c.header("Content-Type", "text/plain");
  const { code: authCode, error: errorQ, error_description: errorDescription } =
    c.req.query();
  if (authCode) {
    const fetchResponse = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: Deno.env.get("TWITCH_CLIENT_ID"),
        client_secret: Deno.env.get("TWITCH_CLIENT_SECRET"),
        code: authCode,
        grant_type: "authorization_code",
        redirect_uri: Deno.env.get("TWITCH_REDIRECT_URI"),
      }),
    });
    if (fetchResponse.ok) {
      const json = await fetchResponse.json();
      const accessToken = json.access_token;
      const user = await getUser(
        null,
        Deno.env.get("TWITCH_CLIENT_ID"),
        accessToken,
      );
      if (user.display_name.toLowerCase() == user.login) {
        c.text(`Got Tokens for ${user.display_name}`);
      } else {
        c.text(
          `Got Tokens for ${user.display_name} (${user.login})`,
        );
      }
    } else {
      res.text(await fetchResponse.text());
    }
  } else if (errorQ) {
    if (errorDescription) {
      res.text(
        `The following error occured:\n${errorQ}\n${errorDescription}`,
      );
    } else {
      res.text(`The following error occured:\n${errorQ}`);
    }
  } else {
    res.text(
      "This endpoint is intended to be redirected from Twitch's auth flow. It is not meant to be called directly",
    );
  }
}
