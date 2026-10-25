// Decode only the production environment builder in memory. No profile,
// fixture process, file/registry/ACL mutation, model or network operation.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

static class ProbeEnvironmentSelfTest {
  const BindingFlags PrivateInstance=BindingFlags.Instance|BindingFlags.NonPublic;
  static int assertions;
  static void Check(bool value,string label){assertions++;if(!value)throw new Exception(label);}
  static IDictionary<string,string> Decode(HubClaudeLpacProbe probe){return DecodeMethod(probe,"EnvironmentBlock");}
  static IDictionary<string,string> DecodeMethod(HubClaudeLpacProbe probe,string method){
    IntPtr block=(IntPtr)typeof(HubClaudeLpacProbe).GetMethod(method,PrivateInstance).Invoke(probe,null);
    try{
      if(block==IntPtr.Zero)throw new Exception("null environment block");
      Dictionary<string,string> values=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      int position=0;string previous=null;
      while(position<8192){
        if(Marshal.ReadInt16(block,position*2)==0){
          if(position==0||Marshal.ReadInt16(block,(position-1)*2)!=0)throw new Exception("missing double-NUL terminator");
          return values;
        }
        int start=position;
        while(position<8192&&Marshal.ReadInt16(block,position*2)!=0)position++;
        if(position==8192)throw new Exception("environment block exceeds fixed test bound");
        string row=Marshal.PtrToStringUni(IntPtr.Add(block,start*2),position-start);position++;
        int separator=row.IndexOf('=');
        if(separator<=0)throw new Exception("malformed environment row");
        string key=row.Substring(0,separator),value=row.Substring(separator+1);
        if(values.ContainsKey(key)||previous!=null&&StringComparer.OrdinalIgnoreCase.Compare(previous,key)>=0)throw new Exception("duplicate or unordered environment key");
        values.Add(key,value);previous=key;
      }
      throw new Exception("environment block has no bounded terminator");
    }finally{if(block!=IntPtr.Zero)Marshal.FreeHGlobal(block);}
  }
  static int Main(){
    // Assign synthetic strings only; these paths are never created or opened.
    string root=@"C:\W0-Environment-Only-Never-Created",profile=@"C:\W0-Profile-Only-Never-Created";
    string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
    HubClaudeLpacProbe probe=new HubClaudeLpacProbe();
    typeof(HubClaudeLpacProbe).GetField("root",PrivateInstance).SetValue(probe,root);
    typeof(HubClaudeLpacProbe).GetField("profileFolder",PrivateInstance).SetValue(probe,profile);
    Dictionary<string,string> expected=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase){
      {"SystemRoot",windows},{"WINDIR",windows},{"PATH",Path.Combine(root,"runtime")+";"+Path.Combine(windows,"System32")},
      {"USERPROFILE",profile},{"HOME",profile},{"APPDATA",profile},{"LOCALAPPDATA",profile},
      {"TEMP",Path.Combine(root,"tmp")},{"TMP",Path.Combine(root,"tmp")},{"CLAUDE_CONFIG_DIR",profile},
      {"COMPLUS_InstallRoot",Path.Combine(windows,"Microsoft.NET","Framework64")+Path.DirectorySeparatorChar},
      {"COMPLUS_Version","v4.0.30319"}};
    IDictionary<string,string> baseline=Decode(probe);
    Check(baseline.Count==12&&expected.Count==12,"exact allowlist size");
    foreach(KeyValuePair<string,string> entry in expected)Check(baseline.ContainsKey(entry.Key)&&baseline[entry.Key]==entry.Value,"exact baseline environment value");
    IDictionary<string,string> identity=DecodeMethod(probe,"IdentityEnvironmentBlock");
    Check(identity.Count==13,"identity only adds one logging key");
    Check(identity["COMPLUS_CLRLoadLogDir"]==Path.Combine(root,"tmp"),"identity logger fixed to owned tmp");
    foreach(KeyValuePair<string,string> entry in baseline)Check(identity[entry.Key]==entry.Value,"identity retains entire common environment");
    string[] keys={"COMPLUS_InstallRoot","COMPLUS_Version","COMPLUS_CLRLoadLogDir","COMPLUS_EnableDiagnostics",
      "COMPLUS_ApplicationMigrationRuntimeActivationConfigPath","COMPLUS_OnlyUseLatestCLR",
      "COR_ENABLE_PROFILING","COR_PROFILER","CORECLR_ENABLE_PROFILING","CORECLR_PROFILER","DOTNET_STARTUP_HOOKS","HUB_PRIVATE_MARKER"};
    Dictionary<string,string> original=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    const string marker="SYNTHETIC_AMBIENT_MUST_NOT_PROPAGATE";
    foreach(string key in keys)original.Add(key,Environment.GetEnvironmentVariable(key,EnvironmentVariableTarget.Process));
    try{
      foreach(string key in keys){Environment.SetEnvironmentVariable(key,marker,EnvironmentVariableTarget.Process);Check(Environment.GetEnvironmentVariable(key,EnvironmentVariableTarget.Process)==marker,"ambient marker set only in this test process");}
      IDictionary<string,string> polluted=Decode(probe);
      Check(polluted.Count==12,"no ambient keys enter allowlist");
      foreach(KeyValuePair<string,string> entry in expected)Check(polluted.ContainsKey(entry.Key)&&polluted[entry.Key]==entry.Value,"pollution cannot change exact value");
      foreach(KeyValuePair<string,string> entry in baseline)Check(polluted[entry.Key]==entry.Value,"entire decoded block unchanged");
      IDictionary<string,string> identityPolluted=DecodeMethod(probe,"IdentityEnvironmentBlock");
      Check(identityPolluted.Count==13,"pollution cannot add identity keys");
      Check(identityPolluted["COMPLUS_CLRLoadLogDir"]==Path.Combine(root,"tmp"),"caller cannot select log directory");
      foreach(KeyValuePair<string,string> entry in baseline)Check(identityPolluted[entry.Key]==entry.Value,"pollution cannot change identity environment");
      foreach(string key in keys)Check(Environment.GetEnvironmentVariable(key,EnvironmentVariableTarget.Process)==marker,"builder does not mutate caller environment");
    }finally{foreach(KeyValuePair<string,string> entry in original)Environment.SetEnvironmentVariable(entry.Key,entry.Value,EnvironmentVariableTarget.Process);}
    foreach(KeyValuePair<string,string> entry in original)Check(Environment.GetEnvironmentVariable(entry.Key,EnvironmentVariableTarget.Process)==entry.Value,"test restores its own process environment");
    Console.WriteLine(new JavaScriptSerializer().Serialize(new {schemaVersion=1,assertions=assertions,allowlistKeys=12,identityAllowlistKeys=13,pollutionMarkers=12,profileCreated=false,fixtureProcessStarted=false,target="environment-builder-memory-only"}));
    return 0;
  }
}
