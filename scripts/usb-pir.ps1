param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^COM[1-9][0-9]*$')]
    [string]$Port,
    [ValidateRange(300, 1000000)]
    [int]$Baud = 9600,
    [switch]$Probe
)

$ErrorActionPreference = 'Stop'
$serial = [System.IO.Ports.SerialPort]::new($Port, $Baud, 'None', 8, 'One')
$serial.ReadTimeout = 500
$serial.NewLine = "`n"
try {
    $serial.Open()
    if ($Probe) {
        [Console]::WriteLine("Reading $Port. Walk past the sensor and note the lines. Press Ctrl+C when done.")
    } else {
        [Console]::WriteLine('{"connected":true}')
    }
    while ($true) {
        try {
            $line = $serial.ReadLine().Trim()
        } catch [System.TimeoutException] {
            continue
        }
        if ($line.Length -eq 0 -or $line.Length -gt 256) { continue }
        if ($Probe) {
            [Console]::WriteLine($line)
        } else {
            [Console]::WriteLine((@{ line = $line } | ConvertTo-Json -Compress))
        }
    }
} finally {
    $serial.Dispose()
}
