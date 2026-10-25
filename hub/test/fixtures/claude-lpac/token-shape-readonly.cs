// Fixed current-primary/Identification-duplicate token query diagnostic.
// No profile, child, thread impersonation, ACL, registry or authentication API.
// Only class21's canonical restriction Boolean is serialized, no raw payload.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

static class ProbeTokenShapeReadOnly {
  const int Unwritten=0x13579bdf;
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token,uint access,IntPtr attrs,int level,int type,out IntPtr duplicate);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int capacity,ref int returned);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationToken(IntPtr token,int kind,IntPtr data,int capacity,ref int returned);
  static object Query(IntPtr token,string tokenKind,int kind,int capacity,bool native){
    IntPtr data=capacity==0?IntPtr.Zero:Marshal.AllocHGlobal(capacity);
    try{
      if(data!=IntPtr.Zero)Marshal.Copy(new byte[capacity],0,data,capacity);
      int returned=Unwritten,error=0,status=0;bool success;
      if(native){status=NtQueryInformationToken(token,kind,data,capacity,ref returned);success=status==0;}
      else{SetLastError(0);success=GetTokenInformation(token,kind,data,capacity,ref returned);error=Marshal.GetLastWin32Error();}
      object restriction=null;string encoding=null;
      if(success&&kind==21&&returned>0&&returned<=capacity){
        if(returned==1){byte value=Marshal.ReadByte(data);if(value<=1){restriction=value==1;encoding="BOOLEAN-1";}}
        else if(returned==4){int value=Marshal.ReadInt32(data);if(value==0||value==1){restriction=value==1;encoding="DWORD-4";}}
      }
      var row=new SortedDictionary<string,object>(StringComparer.Ordinal);
      row["tokenKind"]=tokenKind;row["api"]=native?"NtQueryInformationToken":"GetTokenInformation";row["class"]=kind;
      row["capacity"]=capacity;row["success"]=success;row["returnLengthUntouched"]=returned==Unwritten;
      row["returnLengthObserved"]=returned==Unwritten?null:(object)returned;
      row["restrictionBoolean"]=restriction;row["restrictionEncoding"]=encoding;
      if(native)row["ntstatus"]="0x"+unchecked((uint)status).ToString("x8");else row["nativeError"]=success?0:error;
      return row;
    }finally{if(data!=IntPtr.Zero)Marshal.FreeHGlobal(data);}
  }
  static int Main(string[] args){
    if(args.Length!=0)return 2;IntPtr token=IntPtr.Zero,duplicate=IntPtr.Zero;int exit=0;
    try{
      if(!OpenProcessToken(GetCurrentProcess(),10,out token))return 3;
      if(!DuplicateTokenEx(token,8,IntPtr.Zero,1,2,out duplicate))return 4;
      var rows=new List<object>();
      foreach(bool dup in new bool[]{false,true}){
        IntPtr source=dup?duplicate:token;string label=dup?"identification-duplicate":"current-primary";
        foreach(int kind in new int[]{8,9,21,29})foreach(int capacity in new int[]{0,1,4,16})rows.Add(Query(source,label,kind,capacity,false));
        foreach(int capacity in new int[]{0,1,4,16})rows.Add(Query(source,label,21,capacity,true));
      }
      Console.WriteLine(new JavaScriptSerializer().Serialize(new{schemaVersion=1,target="current-process-only",profileCreated=false,threadImpersonated=false,rawTokenPayloadSerialized=false,restrictionBooleanSerialized=true,rows=rows}));
    }finally{
      if(duplicate!=IntPtr.Zero&&!CloseHandle(duplicate))exit=5;
      if(token!=IntPtr.Zero&&!CloseHandle(token))exit=5;
    }
    return exit;
  }
}
