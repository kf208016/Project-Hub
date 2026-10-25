// Query drive TYPES only. No path supplied by a caller is opened or queried.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
class HubLocalDrives {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
  static int Main() {
    try {
      Console.OutputEncoding = new UTF8Encoding(false, true);
      Dictionary<string, uint> types = new Dictionary<string, uint>();
      for (char letter='A'; letter<='Z'; letter++) types[letter.ToString()] = GetDriveTypeW(letter + ":\\");
      Console.WriteLine(new JavaScriptSerializer().Serialize(types));
      return 0;
    } catch { return 2; }
  }
}
