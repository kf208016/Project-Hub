// Local fault-injection harness, compiled with an explicit /main selector.
// Never submits an execution request or creates an AppContainer profile.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

static class ProbeResultSelfTest {
  const BindingFlags Instance=BindingFlags.Instance|BindingFlags.NonPublic;
  const BindingFlags Static=BindingFlags.Static|BindingFlags.NonPublic;
  static int assertions;
  static void Check(bool value,string label){assertions++;if(!value)throw new Exception(label);}
  static FieldInfo Field(string name){return typeof(HubClaudeLpacProbe).GetField(name,Instance);}
  static object Fresh(){return Activator.CreateInstance(typeof(HubClaudeLpacProbe),true);}
  static int Exit(string code,bool bootstrap,bool suite,bool cleanup,bool error,string phase){return (int)typeof(HubClaudeLpacProbe).GetMethod("ResultExitCode",Static).Invoke(null,new object[]{code,bootstrap,suite,cleanup,error,phase});}
  sealed class ReceiptStream:FileStream {
    readonly int failAt;int calls;
    public ReceiptStream(string path,int fail):base(path,FileMode.CreateNew,FileAccess.Write,FileShare.None){failAt=fail;}
    public override void Flush(bool durable){if(++calls==failAt)throw new IOException("SYNTHETIC_FLUSH_FAILURE");base.Flush(durable);}
  }
  static void Receipt(int failAt){
    string path=Path.Combine(Path.GetDirectoryName(typeof(ProbeResultSelfTest).Assembly.Location),"receipt-"+Guid.NewGuid().ToString("N")+".jsonl");
    try{
      object probe=Fresh();
      using(ReceiptStream stream=new ReceiptStream(path,failAt)){
        Field("journal").SetValue(probe,stream);
        // Empty-state cleanup: created=false, root=null, no pins, jobEmpty=true.
        // Thus this calls no profile, ACL, process or deletion API.
        bool threw=false;
        try{typeof(HubClaudeLpacProbe).GetMethod("Cleanup",Instance).Invoke(probe,null);}
        catch(TargetInvocationException e){Check(e.InnerException is IOException,"expected injected I/O failure");threw=true;}
        Check(threw==(failAt!=0),"receipt failure observed");
        Check((bool)Field("cleanupVerified").GetValue(probe)==(failAt==0),"durable receipts gate cleanup flag");
        Check((string)Field("stage").GetValue(probe)==(failAt==0?"closed":"cleaning"),"failed receipt cannot close state");
        bool closed=false;
        foreach(object item in (IEnumerable)Field("events").GetValue(probe))if((string)((IDictionary<string,object>)item)["kind"]=="closed")closed=true;
        Check(closed==(failAt==0),"failed final receipt not published in events");
      }
    }finally{if(File.Exists(path))File.Delete(path);}
  }
  static int Main(){
    Check(Exit("W0_NATIVE_CASES_PASSED",true,true,true,false,"closed")==0,"complete native success");
    Check(Exit("W0_INTERNAL_FAILURE",true,true,true,false,"closed")==1,"suite receipt error after complete measurements");
    Check(Exit("W0_NATIVE_CASES_PASSED",true,true,true,true,"closed")==1,"cleanup error despite stale true flag");
    Check(Exit("W0_NATIVE_CASES_PASSED",true,true,false,false,"closed")==1,"cleanup unknown");
    Check(Exit("W0_NATIVE_CASES_PASSED",true,true,true,false,"cleaning")==1,"not durably closed");
    Check(Exit("W0_NATIVE_CASES_PASSED",false,true,true,false,"closed")==1,"bootstrap incomplete");
    Check(Exit("W0_NATIVE_CASES_PASSED",true,false,true,false,"closed")==1,"suite incomplete");
    Receipt(2);Receipt(3);Receipt(0);
    object state=Fresh();Field("cleanupVerified").SetValue(state,true);Field("stage").SetValue(state,"closed");
    typeof(HubClaudeLpacProbe).GetMethod("CleanupFailed",Instance).Invoke(state,new object[]{"CLEANUP_UNKNOWN",0});
    Check(!(bool)Field("cleanupVerified").GetValue(state),"cleanup exception clears prior success");
    Check((string)Field("stage").GetValue(state)=="cleaning","cleanup exception rolls back closed state");
    Console.WriteLine("receipt/result fault checks passed: "+assertions);return 0;
  }
}
