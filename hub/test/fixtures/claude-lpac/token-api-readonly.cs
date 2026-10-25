// Fixed, read-only diagnostic of this executable's current-process token.
// TOKEN_QUERY only. No payload/SID bytes are serialized; no other process,
// duplicate/impersonation token, profile, ACL or authentication APIs are used.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

static class ProbeTokenApiReadOnly {
  const int Unwritten=0x13579bdf;
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int capacity,ref int returned);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationToken(IntPtr token,int kind,IntPtr buffer,int capacity,ref int returned);
  static object Query(IntPtr token,int kind,int capacity,bool native){
    IntPtr buffer=capacity==0?IntPtr.Zero:Marshal.AllocHGlobal(capacity);
    try{
      int returned=Unwritten,status=0,error=0;bool success;
      if(native){status=NtQueryInformationToken(token,kind,buffer,capacity,ref returned);success=status==0;}
      else {SetLastError(0);success=GetTokenInformation(token,kind,buffer,capacity,ref returned);error=Marshal.GetLastWin32Error();}
      var row=new SortedDictionary<string,object>(StringComparer.Ordinal);
      row["class"]=kind;row["capacity"]=capacity;row["success"]=success;
      row["returnLengthUntouched"]=returned==Unwritten;row["returnLength"]=returned==Unwritten?null:(object)returned;
      if(native)row["ntstatus"]="0x"+unchecked((uint)status).ToString("x8");else row["win32Code"]=error;
      return row;
    }finally{if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);}
  }
  static int Main(string[] args){
    if(args.Length!=0)return 2;
    IntPtr token; if(!OpenProcessToken(GetCurrentProcess(),8,out token))return 3;
    try{
      var win32=new List<object>();var native=new List<object>();
      foreach(int kind in new int[]{8,29,30,31,46}){
        win32.Add(Query(token,kind,0,false));
        win32.Add(Query(token,kind,kind==30?16:kind==31?IntPtr.Size:4,false));
        if(kind==30||kind==31)win32.Add(Query(token,kind,65536,false));
      }
      foreach(int capacity in new int[]{8,16})win32.Add(Query(token,46,capacity,false));
      foreach(int kind in new int[]{29,46})foreach(int capacity in new int[]{0,4,8,16})native.Add(Query(token,kind,capacity,true));
      Console.WriteLine(new JavaScriptSerializer().Serialize(new {schemaVersion=1,target="current-process-only",tokenAccess=8,profileCreated=false,payloadSerialized=false,win32=win32,native=native}));
    }finally{if(!CloseHandle(token))Environment.Exit(4);}
    return 0;
  }
}
