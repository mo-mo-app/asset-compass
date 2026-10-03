function publicEnvironment(configuredValue) {
  return configuredValue === "preview" ? "preview" : "local";
}

function renderIndexHtml(html, configuredValue) {
  const environment = publicEnvironment(configuredValue);
  let output = html.replace('<html lang="ja">', `<html lang="ja" data-environment="${environment}">`);
  if (environment === "preview") {
    output = output
      .replace("<title>Asset Compass | 資産管理</title>", "<title>[PREVIEW] Asset Compass</title>")
      .replace('name="theme-color" content="#0f2b2d"', 'name="theme-color" content="#2b203d"')
      .replace('href="/assets/favicon.svg"', 'href="/assets/favicon-preview.svg"');
  }
  return output;
}

module.exports = { publicEnvironment, renderIndexHtml };
