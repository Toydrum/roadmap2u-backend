$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$fixtureDirectory = [IO.Path]::GetFullPath([string]$inputData.directory)
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $fixtureDirectory.StartsWith($temporaryBase,[StringComparison]::OrdinalIgnoreCase) -or -not [IO.Directory]::Exists($fixtureDirectory)) { throw 'OWNED_TEMP_FIXTURE_REQUIRED' }
$rsa = [Security.Cryptography.RSA]::Create(2048)
$rootRsa = [Security.Cryptography.RSA]::Create(2048)
$rootCertificate = $null
$certificate = $null
try {
  $rootRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Clock local test root',$rootRsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $rootRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
  $rootUsage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
  $rootRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($rootUsage,$true))
  $rootRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($rootRequest.PublicKey,$false))
  $rootCertificate = $rootRequest.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddDays(2))
  $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Clock local TLS server',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
  $usage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage,$true))
  $eku = [Security.Cryptography.OidCollection]::new()
  [void]$eku.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku,$false))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($request.PublicKey,$false))
  $names = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  if ($inputData.wrongHost -eq $true) { $names.AddDnsName('wrong.invalid') }
  else { $names.AddDnsName('localhost'); $names.AddIpAddress([Net.IPAddress]::Parse('127.0.0.1')) }
  $request.CertificateExtensions.Add($names.Build())
  $serial = [Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
  $certificate = $request.Create($rootCertificate,[DateTimeOffset]::UtcNow.AddMinutes(-2),[DateTimeOffset]::UtcNow.AddDays(1),$serial)
  [IO.File]::WriteAllText((Join-Path $fixtureDirectory 'ca.pem'),$rootCertificate.ExportCertificatePem(),[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $fixtureDirectory 'cert.pem'),$certificate.ExportCertificatePem(),[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $fixtureDirectory 'key.pem'),$rsa.ExportPkcs8PrivateKeyPem(),[Text.UTF8Encoding]::new($false))
} finally { if ($null -ne $certificate) { $certificate.Dispose() }; if ($null -ne $rootCertificate) { $rootCertificate.Dispose() }; $rsa.Dispose(); $rootRsa.Dispose() }
[Console]::Out.Write('SYNTHETIC_TLS_FIXTURE_CREATED')
