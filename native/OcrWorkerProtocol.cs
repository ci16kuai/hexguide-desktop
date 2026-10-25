using System;
using System.Collections.Generic;
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
                string record = Utf8.GetString(buffer, 0, length);
                ValidateControlRecord(record);
                return record;
            }
            if (length == buffer.Length) throw new InvalidDataException("OCR protocol record exceeds 1024 bytes.");
            buffer[length++] = (byte)value;
        }
    }

    private static void SkipWhitespace(string record, ref int index)
    {
        while (index < record.Length && (record[index] == ' ' || record[index] == '\t' || record[index] == '\r' || record[index] == '\n')) index++;
    }

    private static string ReadString(string record, ref int index)
    {
        if (index >= record.Length || record[index++] != '"') throw new InvalidDataException("Invalid OCR protocol string.");
        var value = new StringBuilder();
        while (index < record.Length)
        {
            char current = record[index++];
            if (current == '"') return value.ToString();
            if (current < 32) throw new InvalidDataException("Invalid OCR protocol string.");
            if (current != '\\') { value.Append(current); continue; }
            if (index == record.Length) break;
            char escape = record[index++];
            switch (escape)
            {
                case '"': case '\\': case '/': value.Append(escape); break;
                case 'b': value.Append('\b'); break;
                case 'f': value.Append('\f'); break;
                case 'n': value.Append('\n'); break;
                case 'r': value.Append('\r'); break;
                case 't': value.Append('\t'); break;
                case 'u':
                    int code = 0;
                    for (int digit = 0; digit < 4; digit++)
                    {
                        if (index == record.Length) throw new InvalidDataException("Invalid OCR protocol escape.");
                        char hex = record[index++];
                        int nibble = hex >= '0' && hex <= '9' ? hex - '0' : hex >= 'A' && hex <= 'F' ? hex - 'A' + 10 : hex >= 'a' && hex <= 'f' ? hex - 'a' + 10 : -1;
                        if (nibble < 0) throw new InvalidDataException("Invalid OCR protocol escape.");
                        code = code * 16 + nibble;
                    }
                    value.Append((char)code);
                    break;
                default: throw new InvalidDataException("Invalid OCR protocol escape.");
            }
        }
        throw new InvalidDataException("Unterminated OCR protocol string.");
    }

    private static void ReadNumber(string record, ref int index)
    {
        if (index < record.Length && record[index] == '-') index++;
        if (index == record.Length) throw new InvalidDataException("Invalid OCR protocol number.");
        if (record[index] == '0') index++;
        else
        {
            if (record[index] < '1' || record[index] > '9') throw new InvalidDataException("Invalid OCR protocol number.");
            while (index < record.Length && record[index] >= '0' && record[index] <= '9') index++;
        }
        if (index < record.Length && record[index] == '.')
        {
            index++;
            int start = index;
            while (index < record.Length && record[index] >= '0' && record[index] <= '9') index++;
            if (index == start) throw new InvalidDataException("Invalid OCR protocol number.");
        }
        if (index < record.Length && (record[index] == 'e' || record[index] == 'E'))
        {
            index++;
            if (index < record.Length && (record[index] == '+' || record[index] == '-')) index++;
            int start = index;
            while (index < record.Length && record[index] >= '0' && record[index] <= '9') index++;
            if (index == start) throw new InvalidDataException("Invalid OCR protocol number.");
        }
    }

    // ConvertFrom-Json keeps only the last duplicate property. Check decoded
    // control keys before that lossy conversion, including escaped spellings.
    // The schema needs only strings/numbers, so nested values are rejected.
    private static void ValidateControlRecord(string record)
    {
        int index = 0;
        var keys = new HashSet<string>(StringComparer.Ordinal);
        SkipWhitespace(record, ref index);
        if (index == record.Length || record[index++] != '{') throw new InvalidDataException("Invalid OCR protocol object.");
        for (;;)
        {
            SkipWhitespace(record, ref index);
            string key = ReadString(record, ref index);
            if ((key != "version" && key != "type" && key != "id") || !keys.Add(key)) throw new InvalidDataException("Invalid or duplicate OCR protocol field.");
            SkipWhitespace(record, ref index);
            if (index == record.Length || record[index++] != ':') throw new InvalidDataException("Invalid OCR protocol field.");
            SkipWhitespace(record, ref index);
            if (index < record.Length && record[index] == '"') ReadString(record, ref index);
            else ReadNumber(record, ref index);
            SkipWhitespace(record, ref index);
            if (index == record.Length) throw new InvalidDataException("Truncated OCR protocol object.");
            char delimiter = record[index++];
            if (delimiter == '}') break;
            if (delimiter != ',') throw new InvalidDataException("Invalid OCR protocol delimiter.");
        }
        SkipWhitespace(record, ref index);
        if (index != record.Length || keys.Count != 3) throw new InvalidDataException("Invalid OCR protocol fields.");
    }
}
