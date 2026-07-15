@echo off
REM Serves this folder at http://localhost:8765 so the game can fetch cards.csv.
REM Browsers block fetch() on file:// addresses, so the game needs a real
REM http server even when you're just running it locally. Double-click this,
REM then open http://localhost:8765 . Close this window to stop the server.
echo.
echo   Hell Tower - local server
echo   ------------------------------------
echo   Open:  http://localhost:8765
echo   Stop:  close this window (or Ctrl+C)
echo.
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $root=$PSScriptRoot; if(-not $root){$root=(Get-Location).Path}; $root='%~dp0'.TrimEnd('\'); $l=New-Object System.Net.HttpListener; $l.Prefixes.Add('http://localhost:8765/'); $l.Start(); $mime=@{'.html'='text/html';'.js'='text/javascript';'.css'='text/css';'.csv'='text/csv; charset=utf-8';'.json'='application/json';'.png'='image/png';'.jpg'='image/jpeg';'.svg'='image/svg+xml'}; Write-Host ('Serving ' + $root); while($l.IsListening){ $c=$l.GetContext(); $rq=$c.Request; $rs=$c.Response; try { $p=[System.Uri]::UnescapeDataString($rq.Url.AbsolutePath); if($p -eq '/'){$p='/index.html'}; $fp=Join-Path $root ($p.TrimStart('/')); $full=[System.IO.Path]::GetFullPath($fp); if($full.StartsWith([System.IO.Path]::GetFullPath($root)) -and (Test-Path $full -PathType Leaf)){ $b=[System.IO.File]::ReadAllBytes($full); $ext=[System.IO.Path]::GetExtension($full); $ct=$mime[$ext]; if(-not $ct){$ct='application/octet-stream'}; $rs.ContentType=$ct; $rs.Headers.Add('Cache-Control','no-store'); $rs.ContentLength64=$b.Length; $rs.OutputStream.Write($b,0,$b.Length); Write-Host ('200 ' + $p) } else { $rs.StatusCode=404; Write-Host ('404 ' + $p) } } catch { $rs.StatusCode=500 } finally { $rs.Close() } }"
pause
