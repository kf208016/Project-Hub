// Pure result/size guards plus read-only calls on this executable's own token.
// No profile, ACL, auth, duplicate/impersonation or other-process token APIs.
using System;
using System.Reflection;
using System.Runtime.InteropServices;

static class ProbeTokenQuerySelfTest {
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int capacity,out int returned);
  const BindingFlags PrivateStatic=BindingFlags.Static|BindingFlags.NonPublic;
  static int assertions;
  static void Check(bool value,string label){assertions++;if(!value)throw new Exception(label);}
  static object Call(string name,params object[] args){return typeof(HubClaudeLpacProbe).GetMethod(name,PrivateStatic).Invoke(null,args);}
  static void Rejection(string name,object[] args,string code,int native){
    bool rejected=false;
    try{Call(name,args);}catch(TargetInvocationException e){
      Type type=e.InnerException.GetType();
      Check(type.Name=="Rejected","guard rejects through fixed native error envelope");
      Check((string)type.GetField("Code").GetValue(e.InnerException)==code,"class and reason preserved");
      Check((int)type.GetField("Native").GetValue(e.InnerException)==native,"original failure code preserved");rejected=true;
    }
    Check(rejected,"unsafe API response rejected");
  }
  static int Main(){
    foreach(int size in new int[]{1,4,65536})Check((int)Call("TokenSizingCapacity",46,false,122,size)==size,"valid bounded sizing");
    foreach(int size in new int[]{0,-1,65537,Int32.MaxValue})Rejection("TokenSizingCapacity",new object[]{46,false,122,size},"TOKEN_CLASS_46_SIZE_INVALID",122);
    foreach(int error in new int[]{0,5,6,87})foreach(int stale in new int[]{0,4})Rejection("TokenSizingCapacity",new object[]{46,false,error,stale},"TOKEN_CLASS_46_QUERY_UNAVAILABLE",error);
    foreach(int size in new int[]{0,4})Rejection("TokenSizingCapacity",new object[]{46,true,122,size},"TOKEN_CLASS_46_SIZE_QUERY_INVALID",0);
    foreach(int size in new int[]{1,4,65536})Check((int)Call("TokenReturnedLength",46,true,87,65536,size)==size,"successful buffer length; stale LastError ignored");
    foreach(int size in new int[]{0,-1,5,65537})Rejection("TokenReturnedLength",new object[]{46,true,0,4,size},"TOKEN_CLASS_46_SIZE_INVALID",0);
    foreach(int capacity in new int[]{0,-1,65537})Rejection("TokenReturnedLength",new object[]{46,true,0,capacity,1},"TOKEN_CLASS_46_SIZE_INVALID",0);
    foreach(int error in new int[]{5,6,87,122})Rejection("TokenReturnedLength",new object[]{46,false,error,4,4},"TOKEN_CLASS_46_QUERY_FAILED",error);
    Check((string)Call("TokenQueryCode",29,"QUERY_UNAVAILABLE")=="TOKEN_CLASS_29_QUERY_UNAVAILABLE","class attribution is not hard-coded to LPAC");
    IntPtr token;Check(OpenProcessToken(GetCurrentProcess(),8,out token),"open only own current-process token with TOKEN_QUERY");
    try{
      foreach(int kind in new int[]{8,29,30,31,46}){
        int needed;bool sized=GetTokenInformation(token,kind,IntPtr.Zero,0,out needed);int error=Marshal.GetLastWin32Error();
        object[] args=new object[]{token,kind,0};IntPtr data=IntPtr.Zero;
        try{
          data=(IntPtr)Call("TokenData",args);
          Check(!sized&&error==122&&needed>0&&needed<=65536,"production query requires valid API sizing");
          Check(data!=IntPtr.Zero&&(int)args[2]>0&&(int)args[2]<=needed,"bounded successful query");
          if(kind==8||kind==29||kind==46)Check((int)args[2]==4,"scalar output is still exactly DWORD");
        }catch(TargetInvocationException e){
          Type type=e.InnerException.GetType();Check(type.Name=="Rejected"&&kind==46,"only the LPAC query may be unavailable in this readonly test");
          Check(!sized&&error!=122,"readonly native failure must match the first API failure");
          Check((string)type.GetField("Code").GetValue(e.InnerException)=="TOKEN_CLASS_"+kind+"_QUERY_UNAVAILABLE","production reports exact unavailable class");
          Check((int)type.GetField("Native").GetValue(e.InnerException)==error,"production retains readonly native error");
        }finally{if(data!=IntPtr.Zero)Marshal.FreeHGlobal(data);}
      }
    }finally{Check(CloseHandle(token),"close own token");}
    Console.WriteLine("token query checks passed: "+assertions);return 0;
  }
}
