// Owned synthetic files only; no LPAC profile, fixture process, auth or network.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Web.Script.Serialization;

static class ProbeClrLogSelfTest {
  const BindingFlags PrivateInstance=BindingFlags.Instance|BindingFlags.NonPublic;
  const BindingFlags PrivateStatic=BindingFlags.Static|BindingFlags.NonPublic;
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateHardLink(string link,string target,IntPtr attributes);
  static int assertions;
  static readonly List<string> cases=new List<string>();
  static void Check(bool value,string label){assertions++;if(!value)throw new Exception(label);}
  static object Call(string name,params object[] args){return typeof(HubClaudeLpacProbe).GetMethod(name,PrivateStatic).Invoke(null,args);}
  static object Invoke(HubClaudeLpacProbe probe,string name,params object[] args){return typeof(HubClaudeLpacProbe).GetMethod(name,PrivateInstance).Invoke(probe,args);}
  static void Set(HubClaudeLpacProbe probe,string name,object value){typeof(HubClaudeLpacProbe).GetField(name,PrivateInstance).SetValue(probe,value);}
  static void ClosePins(HubClaudeLpacProbe probe){
    var pins=(List<HubPinnedRoot>)typeof(HubClaudeLpacProbe).GetField("pins",PrivateInstance).GetValue(probe);
    foreach(HubPinnedRoot pin in pins)pin.Dispose();pins.Clear();
  }
  static void Reject(string method,object[] args,string code){
    bool rejected=false;try{Call(method,args);}catch(TargetInvocationException error){
      Check(error.InnerException.GetType().Name=="Rejected","typed refusal for "+method+": "+error.InnerException.GetType().Name);
      Check((string)error.InnerException.GetType().GetField("Code").GetValue(error.InnerException)==code,"precise refusal");rejected=true;
    }Check(rejected,"reject unsafe log input");
  }
  static IDictionary<string,object> Capture(HubClaudeLpacProbe probe,string status,string code){
    var state=(IDictionary<string,object>)typeof(HubClaudeLpacProbe).GetField("result",PrivateInstance).GetValue(probe);
    state["code"]="ORIGINAL_FIXTURE_ERROR";state["fixtureExitCode"]=4294967295U;
    Invoke(probe,"CaptureClrActivationLogs");var result=(IDictionary<string,object>)state["clrActivationLogs"];
    Check((string)result["status"]==status&&(string)result["code"]==code,"diagnostic state");
    Check((string)state["code"]=="ORIGINAL_FIXTURE_ERROR"&&(uint)state["fixtureExitCode"]==4294967295U,"diagnostic cannot replace fixture failure");
    if(status!="captured")Check(((List<object>)result["logs"]).Count==0,"failed collection publishes no raw bytes");
    return result;
  }
  static int Main(string[] args){
    Check(args.Length==1,"owned fixture directory required");
    string root=Path.GetFullPath(args[0]),tmp=Path.Combine(root,"tmp"),outside=Path.Combine(root,"outside");
    Check(!Directory.Exists(root)&&!File.Exists(root),"fixture root create-only");
    Directory.CreateDirectory(root);Directory.CreateDirectory(tmp);Directory.CreateDirectory(outside);
    string first=Path.Combine(tmp,"claude-lpac-fixture.exe.CLRLoad00.log"),second=Path.Combine(tmp,"claude-lpac-fixture.exe.CLRLoad01.log"),third=Path.Combine(tmp,"claude-lpac-fixture.exe.CLRLoad02.log"),hard=Path.Combine(outside,"held-source.bin");
    HubClaudeLpacProbe probe=new HubClaudeLpacProbe();Set(probe,"root",root);Set(probe,"owner",WindowsIdentity.GetCurrent().User.Value);
    string identity=(string)Call("IdentityOf",Call("DirectoryInfo",root));Set(probe,"rootIdentity",identity);
    List<object> captured=null;
    try{
      Invoke(probe,"PinDirectory",root);Invoke(probe,"PinDirectory",tmp);
      Check((bool)Call("ClrLogName",Path.GetFileName(first)),"official fixed filename");
      foreach(string invalid in new string[]{"claude-lpac-fixture.CLRLoad00.log","claude-lpac-fixture.exe.CLRLoad100.log",Path.GetFileName(first)+"\n",Path.GetFileName(first)+":ads","../"+Path.GetFileName(first)})Check(!(bool)Call("ClrLogName",invalid),"closed filename");
      cases.Add("fixed-filename");
      Reject("ClrLogPath",new object[]{tmp,Path.Combine(outside,Path.GetFileName(first))},"CLR_LOG_PATH_REJECTED");
      Reject("ClrLogPath",new object[]{tmp,first+":ads"},"CLR_LOG_PATH_REJECTED");
      Reject("ClrLogFileShape",new object[]{0x400U,1U},"CLR_LOG_FILE_TYPE_REJECTED");
      Reject("ClrLogFileShape",new object[]{0x10U,1U},"CLR_LOG_FILE_TYPE_REJECTED");
      Reject("ClrLogFileShape",new object[]{0U,2U},"CLR_LOG_FILE_TYPE_REJECTED");
      cases.Add("cross-root-ads-reparse-and-link-guards");
      Check((int)Call("ClrLogLength",65536L,1,65536L)==65536,"maximum two-file byte budget");
      Reject("ClrLogLength",new object[]{65537L,0,0L},"CLR_LOG_FILE_SIZE_LIMIT");
      Reject("ClrLogLength",new object[]{1L,2,0L},"CLR_LOG_COUNT_LIMIT");
      Reject("ClrLogLength",new object[]{1L,1,131072L},"CLR_LOG_TOTAL_SIZE_LIMIT");
      cases.Add("exact-size-and-count-limits");
      Capture(probe,"absent","CLR_LOGS_ABSENT");cases.Add("absent-not-cause");
      Set(probe,"jobEmpty",false);Capture(probe,"error","CLR_LOG_JOB_NOT_EMPTY");Set(probe,"jobEmpty",true);cases.Add("job-not-empty-refused");
      Set(probe,"rootIdentity","not-the-owned-root");Capture(probe,"error","CLR_LOG_ROOT_CHANGED");Set(probe,"rootIdentity",identity);cases.Add("root-identity-refused");
      File.WriteAllBytes(first,new byte[65536]);File.WriteAllBytes(second,new byte[65536]);
      var bounded=Capture(probe,"captured","CLR_LOGS_CAPTURED");captured=(List<object>)bounded["logs"];
      Check(captured.Count==2,"both maximum-size files captured");
      foreach(IDictionary<string,object> row in captured){Check((int)row["bytes"]==65536&&Convert.FromBase64String((string)row["rawBase64"]).Length==65536,"actual bounded raw bytes");Check(((string)row["sourceFileId"]).Length==25,"source file identity retained");}
      cases.Add("two-64k-files");
      File.WriteAllBytes(third,new byte[]{1});Capture(probe,"error","CLR_LOG_COUNT_LIMIT");File.Delete(third);cases.Add("third-file-refused");
      File.Delete(second);File.WriteAllBytes(first,new byte[65537]);Capture(probe,"error","CLR_LOG_FILE_SIZE_LIMIT");File.Delete(first);cases.Add("oversize-file-refused");
      // Set up this hostile fixture before pinning: the pins themselves refuse
      // CreateHardLink with ERROR_SHARING_VIOLATION. Production pins stay held.
      ClosePins(probe);
      File.WriteAllBytes(hard,new byte[]{1,2,3});bool linked=CreateHardLink(first,hard,IntPtr.Zero);int linkError=Marshal.GetLastWin32Error();Check(linked,"owned synthetic hard link created; Win32="+linkError);
      Invoke(probe,"PinDirectory",root);Invoke(probe,"PinDirectory",tmp);
      Capture(probe,"error","FILE_TYPE_REJECTED");File.Delete(first);File.Delete(hard);cases.Add("actual-hard-link-refused");
      // Collection does not make an unsafe file clean: the existing cleanup must reject it.
      ClosePins(probe);File.WriteAllBytes(hard,new byte[]{4});Check(CreateHardLink(first,hard,IntPtr.Zero),"second owned hard link created");
      Invoke(probe,"PinDirectory",root);Invoke(probe,"PinDirectory",tmp);
      bool unsafeCleanup=false;
      try{Invoke(probe,"DeleteOwnedTree",tmp,false,0);}catch(TargetInvocationException error){unsafeCleanup=error.InnerException.GetType().Name=="Rejected"&&(string)error.InnerException.GetType().GetField("Code").GetValue(error.InnerException)=="CLEANUP_IDENTITY_CHANGED";}
      Check(unsafeCleanup,"original cleanup refuses unsafe hard link");cases.Add("unsafe-cleanup-still-refuses");
    }finally{
      ClosePins(probe);
      foreach(string file in new string[]{first,second,third,hard})if(File.Exists(file))File.Delete(file);
      Directory.Delete(tmp,false);Directory.Delete(outside,false);Directory.Delete(root,false);
    }
    Console.WriteLine(new JavaScriptSerializer().Serialize(new {schemaVersion=1,assertions=assertions,cases=cases,profileCreated=false,fixtureProcessStarted=false,syntheticCapturedLogs=captured}));return 0;
  }
}
