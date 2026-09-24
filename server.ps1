$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://127.0.0.1:8766/')
$listener.Start()
$migration = $null

function Send-Response($response, [int]$status, $body, [string]$contentType = 'application/json; charset=utf-8') {
  $response.StatusCode = $status
  $response.ContentType = $contentType
  $response.Headers.Add('Access-Control-Allow-Origin', '*')
  $bytes = if ($body -is [byte[]]) { $body } else { [Text.Encoding]::UTF8.GetBytes([string]$body) }
  $response.ContentLength64 = $bytes.Length
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.Close()
}

function Get-Quote([string]$symbol) {
  if ($symbol -notmatch '^[A-Za-z0-9.=_^\-]+$') { throw 'Invalid symbol' }
  $encoded = [uri]::EscapeDataString($symbol.ToUpper())
  $uri = "https://query1.finance.yahoo.com/v8/finance/chart/$encoded?range=5d&interval=1d"
  $json = Invoke-RestMethod -Uri $uri -Headers @{ 'User-Agent' = 'AssetCompass/1.0' }
  $meta = $json.chart.result[0].meta
  if ($null -eq $meta.regularMarketPrice) { throw 'Quote unavailable' }
  $previous = $meta.chartPreviousClose
  if ($null -eq $previous) { $previous = $meta.previousClose }
  if ($null -eq $previous) { $previous = $meta.regularMarketPrice }
  return @{ price = $meta.regularMarketPrice; previousClose = $previous }
}

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    $path = $request.Url.AbsolutePath
    try {
      if ($request.HttpMethod -eq 'OPTIONS') { Send-Response $response 204 '' 'text/plain'; continue }
      if ($path -eq '/api/quote') {
        $symbol = $request.QueryString['symbol']
        try { Send-Response $response 200 ((Get-Quote $symbol) | ConvertTo-Json -Compress) }
        catch { Send-Response $response 502 (@{ error = '価格を取得できませんでした'; detail = $_.Exception.Message } | ConvertTo-Json -Compress) }
        continue
      }
      if ($path -eq '/api/migrate' -and $request.HttpMethod -eq 'POST') {
        $reader = [IO.StreamReader]::new($request.InputStream, $request.ContentEncoding)
        $migration = $reader.ReadToEnd() | ConvertFrom-Json
        $reader.Close()
        Send-Response $response 201 '{"ok":true}'
        continue
      }
      if ($path -eq '/api/migration') { $saved = $migration; $migration = $null; if ($null -eq $saved) { $saved = @{} }; Send-Response $response 200 ($saved | ConvertTo-Json -Compress); continue }
      $relative = if ($path -eq '/') { 'index.html' } else { $path.TrimStart('/') }
      $file = Join-Path $root $relative
      if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Send-Response $response 404 'Not found' 'text/plain'; continue }
      $extension = [IO.Path]::GetExtension($file)
      $types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8' }
      $contentType = if ($types.ContainsKey($extension)) { $types[$extension] } else { 'application/octet-stream' }
      Send-Response $response 200 ([IO.File]::ReadAllBytes($file)) $contentType
    } catch { Send-Response $response 500 $_.Exception.Message 'text/plain' }
  }
} finally { if ($listener.IsListening) { $listener.Stop() } }
