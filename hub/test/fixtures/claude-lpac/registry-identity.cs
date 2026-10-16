// Pure in-memory checks for values extracted inside CaptureRegistry.
// Synthetic SIDs/paths only: no token, impersonation, registry or profile API.
using System;
using System.Reflection;

static class ProbeRegistrySelfTest {
  const string Owner="S-1-5-21-1-2-3-1001",OtherOwner="S-1-5-21-1-2-3-1002";
  const string Package="S-1-15-2-1-2-3-4-5-6-7",OtherPackage="S-1-15-2-7-6-5-4-3-2-1";
  const string Hive="\\REGISTRY\\USER\\"+Owner+"\\";
  const string ProfileName="ProjectHub.ClaudeProbe.0123456789abcdef0123456789abcdef";
  static int assertions;
  static readonly MethodInfo TokenMatcher=typeof(HubClaudeLpacProbe).GetMethod("RegistryTokenMatches",BindingFlags.Static|BindingFlags.NonPublic);
  static readonly MethodInfo PathMatcher=typeof(HubClaudeLpacProbe).GetMethod("RegistryStoragePathMatches",BindingFlags.Static|BindingFlags.NonPublic);
  static void Check(bool value,string label){assertions++;if(!value)throw new Exception(label);}
  static bool Token(string expectedOwner,string expectedProfile,string actualOwner,int appContainer,string actualProfile){return (bool)TokenMatcher.Invoke(null,new object[]{expectedOwner,expectedProfile,actualOwner,appContainer,actualProfile});}
  static bool Path(string value,string owner){return (bool)PathMatcher.Invoke(null,new object[]{value,owner});}
  static int Main(){
    Check(TokenMatcher!=null&&PathMatcher!=null,"private value validators exist");
    Check(Token(Owner,Package,Owner,1,Package),"exact verified token fields");
    foreach(int unknown in new int[]{0,-1,2})Check(!Token(Owner,Package,Owner,unknown,Package),"AppContainer must be exactly 1");
    foreach(string invalid in new string[]{null,"","not-a-sid",OtherOwner,Owner+"0"})Check(!Token(Owner,Package,invalid,1,Package),"token owner mismatch or invalid");
    foreach(string invalid in new string[]{null,"","not-a-sid",OtherPackage,Package+"0"})Check(!Token(Owner,Package,Owner,1,invalid),"token profile mismatch or invalid");
    Check(!Token("not-a-sid",Package,"not-a-sid",1,Package),"equal malformed owners cannot bind");
    Check(!Token(Owner,"not-a-sid",Owner,1,"not-a-sid"),"equal malformed profile SIDs cannot bind");
    Check(!Token(Owner.ToLowerInvariant(),Package,Owner.ToLowerInvariant(),1,Package),"noncanonical expected SID cannot bind");
    foreach(string valid in new string[]{Hive+"Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Storage\\"+ProfileName,
      "\\REGISTRY\\USER\\"+Owner+"_Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Storage\\"+ProfileName,
      Hive+"Storage\\"+Package,Hive+"Storage\\\ud83d\ude00",(Hive+"Storage\\"+ProfileName).ToLowerInvariant()})Check(Path(valid,Owner),"bounded API path in exact owner hive");
    foreach(string invalid in new string[]{null,"","\\REGISTRY\\USER\\"+Owner,"\\REGISTRY\\USER\\"+Owner+"\\",
      "\\REGISTRY\\USER\\"+Owner+"0\\Storage\\"+ProfileName,"\\REGISTRY\\USER\\"+Owner+"_ClassesExtra\\Storage\\"+ProfileName,
      "\\REGISTRY\\USER\\"+OtherOwner+"\\Storage\\"+ProfileName,"\\REGISTRY\\MACHINE\\"+Owner+"\\Storage\\"+ProfileName,
      "\\REGISTRY\\USER\\Other\\"+Owner+"\\Storage\\"+ProfileName,Hive+"Storage\\\\"+ProfileName,Hive+".\\"+ProfileName,Hive+"..\\"+ProfileName,
      Hive+"Storage/"+ProfileName,Hive+"Storage\\"+ProfileName+"\0suffix",Hive+"Storage\\\ud800",Hive+"Storage\\\udc00",Hive+"Storage\\\ud800x",
      "\\\\REGISTRY\\USER\\"+Owner+"\\Storage\\"+ProfileName,Hive+"Storage\\"+ProfileName+"\\"})Check(!Path(invalid,Owner),"reject malformed or wrong-hive path");
    Check(!Path(Hive+"Storage\\"+ProfileName,"not-a-sid"),"invalid expected owner");
    Check(!Path(Hive+"Storage\\"+ProfileName,null),"unknown expected owner");
    Check(Path(Hive+new string('a',32766-Hive.Length),Owner),"largest UNICODE_STRING with terminator");
    Check(!Path(Hive+new string('a',32767-Hive.Length),Owner),"UNICODE_STRING maximum overflow");
    Console.WriteLine("registry identity checks passed: "+assertions);return 0;
  }
}
