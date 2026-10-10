package com.huangguo.mobile;
import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
public final class SearchAccountVerificationTest {
 @Test public void localProfileDoesNotWaitForAccountNetworkLock()throws Exception{
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
  AccountService account=new AccountService(context,new AppStore(context,"hongguo"));
  java.util.concurrent.CountDownLatch held=new java.util.concurrent.CountDownLatch(1),release=new java.util.concurrent.CountDownLatch(1);
  Thread busy=new Thread(()->{synchronized(account){held.countDown();try{release.await(5,java.util.concurrent.TimeUnit.SECONDS);}catch(InterruptedException ignored){}}});busy.start();
  java.util.concurrent.ExecutorService reader=java.util.concurrent.Executors.newSingleThreadExecutor();
  try{assertTrue(held.await(2,java.util.concurrent.TimeUnit.SECONDS));long start=android.os.SystemClock.elapsedRealtime();
   JSONObject local=reader.submit(()->account.profile()).get(1,java.util.concurrent.TimeUnit.SECONDS);
   assertTrue(local.has("loggedIn"));assertTrue(android.os.SystemClock.elapsedRealtime()-start<1000);
  }finally{release.countDown();busy.join();reader.shutdownNow();}
 }
 @Test public void realShortAndComicSearch()throws Exception{
  HongguoRepository repository=new HongguoRepository();
  assertTrue(repository.search("首辅娇娘").getJSONArray("items").length()>0);
  JSONObject comic=repository.search("聚宝仙盆");assertTrue(comic.getJSONArray("items").length()>0);
  assertEquals("comic",comic.getJSONArray("items").getJSONObject(0).getString("category"));
 }
 @Test public void downloadCurrentResource()throws Exception{
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
  HotUpdateManager hot=HotUpdateManager.get(context);hot.check(true);
  JSONObject status=hot.status();
  assertTrue("r8 staged",status.optLong("revision")>=8||status.optLong("pending")>=8);
 }
 @Test public void currentResourceHealthy()throws Exception{
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
  HotUpdateManager hot=HotUpdateManager.get(context);
  assertEquals(8,hot.status().getLong("revision"));
  JSONObject state=new JSONObject(new String(java.nio.file.Files.readAllBytes(new java.io.File(context.getFilesDir(),"hot-updates/state.json").toPath()),java.nio.charset.StandardCharsets.UTF_8));assertEquals(0,state.optLong("trial"));
 }
}
