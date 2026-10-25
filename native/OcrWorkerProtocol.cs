using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// The worker accepts only small NDJSON control records. Reading bytes directly
// bounds allocation before JSON parsing; an unterminated/oversized record never
// reaches PowerShell's unbounded Console.ReadLine implementation.
public static class HexGuideOcrWorkerProtocol
{
    private static readonly Stream Input = Console.OpenStandardInput();
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

    public static string ReadLine(int timeoutMs)
    {
        var buffer = new byte[1024];
        var one = new byte[1];
        var clock = Stopwatch.StartNew();
        int length = 0;
        for (;;)
        {
            int value;
            if (timeoutMs < 0) value = Input.ReadByte();
            else
            {
                int remaining = timeoutMs - (int)clock.ElapsedMilliseconds;
                if (remaining <= 0) throw new TimeoutException("OCR acknowledgement timed out.");
                var pendingRead = Input.ReadAsync(one, 0, 1);
                // A timed out read remains owned by this process. Its caller
                // must exit, never start another read or reuse a captured frame.
                if (!pendingRead.Wait(remaining)) throw new TimeoutException("OCR acknowledgement timed out.");
                value = pendingRead.Result == 0 ? -1 : one[0];
            }
            if (value < 0)
            {
                if (length != 0) throw new InvalidDataException("Truncated OCR protocol record.");
                return null;
            }
            if (value == 10)
            {
                if (length > 0 && buffer[length - 1] == 13) length--;
                return Utf8.GetString(buffer, 0, length);
            }
            if (length == buffer.Length) throw new InvalidDataException("OCR protocol record exceeds 1024 bytes.");
            buffer[length++] = (byte)value;
        }
    }
}
